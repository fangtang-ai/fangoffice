CREATE FUNCTION knowledge.close_storage_window(
  requested_window uuid, requested_start timestamptz, requested_end timestamptz,
  requested_tariff text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = on
AS $function$
DECLARE
  principal_owner text := NULLIF(current_setting('knowledge.owner_id', true), '');
  quota_bytes bigint;
  first_change knowledge.kb_metering_events%ROWTYPE;
  tail_change knowledge.kb_metering_events%ROWTYPE;
  next_change knowledge.kb_metering_events%ROWTYPE;
  prior_window knowledge.kb_metering_events%ROWTYPE;
  existing_window knowledge.kb_metering_events%ROWTYPE;
  history_row knowledge.kb_metering_events%ROWTYPE;
  replay_window boolean;
  opening_seq bigint := 0;
  closing_seq bigint := 0;
  running_bytes bigint := 0;
  start_ms numeric;
  end_ms numeric;
  cursor_ms numeric;
  event_ms numeric;
  total_byte_ms numeric := 0;
  previous_time timestamptz;
  history_hash bytea;
  change_count integer := 0;
  event_key text;
BEGIN
  IF principal_owner IS NULL THEN RETURN 'UNAUTHENTICATED'; END IF;
  IF requested_window IS NULL OR requested_start IS NULL OR requested_end IS NULL
     OR NOT isfinite(requested_start) OR NOT isfinite(requested_end)
     OR requested_start <> date_trunc('day', requested_start, 'Asia/Shanghai')
     OR requested_end <> (((requested_start AT TIME ZONE 'Asia/Shanghai')::date + 1)::timestamp
                          AT TIME ZONE 'Asia/Shanghai') THEN
    RETURN 'INVALID_REQUEST';
  END IF;
  IF requested_tariff IS NULL OR char_length(btrim(requested_tariff)) = 0
     OR char_length(requested_tariff) > 128 THEN RETURN 'NOT_CONFIGURED'; END IF;

  -- 与发布/删除共享owner的Quota首锁；冻结/注销仍可结转已经发生的占用，不扩量。
  SELECT active_bytes INTO quota_bytes FROM knowledge.kb_quotas
    WHERE owner_id = principal_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF requested_end > clock_timestamp() THEN RETURN 'FORBIDDEN'; END IF;
  SELECT * INTO tail_change FROM knowledge.kb_metering_events
    WHERE owner_id = principal_owner AND event_type = 'capacity_change'
    ORDER BY sequence DESC LIMIT 1;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF tail_change.active_bytes_after <> quota_bytes THEN RETURN 'VERSION_CONFLICT'; END IF;

  SELECT * INTO existing_window FROM knowledge.kb_metering_events
    WHERE owner_id = principal_owner AND id = requested_window;
  replay_window := FOUND;
  IF replay_window THEN
    IF existing_window.subject_kind <> 'storage_window' OR existing_window.event_type <> 'observation'
       OR existing_window.window_id <> requested_window
       OR existing_window.window_start <> requested_start OR existing_window.window_end <> requested_end
       OR existing_window.tariff_revision IS DISTINCT FROM requested_tariff THEN
      RETURN 'VERSION_CONFLICT';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM knowledge.kb_metering_events
    WHERE owner_id = principal_owner AND subject_kind = 'storage_window'
      AND event_type = 'observation' AND window_start = requested_start) THEN
    RETURN 'VERSION_CONFLICT';
  END IF;

  SELECT * INTO prior_window FROM knowledge.kb_metering_events
    WHERE owner_id = principal_owner AND subject_kind = 'storage_window' AND event_type = 'observation'
      AND (NOT replay_window OR window_start < requested_start)
    ORDER BY window_start DESC LIMIT 1;
  IF FOUND THEN
    IF prior_window.window_end <> requested_start THEN RETURN 'VERSION_CONFLICT'; END IF;
    opening_seq := prior_window.closing_sequence;
    IF opening_seq <> 0 THEN
      SELECT active_bytes_after INTO running_bytes FROM knowledge.kb_metering_events
        WHERE owner_id = principal_owner AND event_type = 'capacity_change' AND sequence = opening_seq;
      IF NOT FOUND THEN RETURN 'VERSION_CONFLICT'; END IF;
    END IF;
  ELSE
    SELECT * INTO first_change FROM knowledge.kb_metering_events
      WHERE owner_id = principal_owner AND event_type = 'capacity_change'
      ORDER BY sequence LIMIT 1;
    IF first_change.sequence <> 1 OR first_change.active_bytes_before <> 0
       OR first_change.occurred_at < requested_start OR first_change.occurred_at >= requested_end THEN
      RETURN 'VERSION_CONFLICT';
    END IF;
  END IF;

  start_ms := floor(extract(epoch FROM requested_start) * 1000);
  end_ms := floor(extract(epoch FROM requested_end) * 1000);
  cursor_ms := start_ms;
  previous_time := requested_start;
  closing_seq := opening_seq;
  history_hash := sha256(convert_to(jsonb_build_array(
    'knowledge:storage-window:v1', principal_owner, start_ms::text, end_ms::text,
    opening_seq::text, running_bytes::text)::text, 'UTF8'));

  -- 有界扫描增量，不逐秒扫文件；同毫秒sequence定序，时间桶用整数毫秒避免浮点及逐段舍入。
  FOR history_row IN SELECT * FROM knowledge.kb_metering_events
    WHERE owner_id = principal_owner AND event_type = 'capacity_change'
      AND occurred_at >= requested_start AND occurred_at < requested_end
    ORDER BY occurred_at, sequence LIMIT 10001
  LOOP
    change_count := change_count + 1;
    IF change_count > 10000 THEN RETURN 'QUOTA_EXCEEDED'; END IF;
    IF history_row.sequence <> closing_seq + 1
       OR history_row.active_bytes_before <> running_bytes
       OR history_row.occurred_at < previous_time THEN RETURN 'VERSION_CONFLICT'; END IF;
    event_ms := floor(extract(epoch FROM history_row.occurred_at) * 1000);
    total_byte_ms := total_byte_ms + running_bytes::numeric * (event_ms - cursor_ms);
    history_hash := sha256(history_hash || convert_to(jsonb_build_array(
      history_row.id::text, history_row.sequence::text,
      (extract(epoch FROM history_row.occurred_at) * 1000000)::text,
      history_row.active_bytes_before::text, history_row.active_bytes_after::text)::text, 'UTF8'));
    running_bytes := history_row.active_bytes_after;
    closing_seq := history_row.sequence;
    cursor_ms := event_ms;
    previous_time := history_row.occurred_at;
  END LOOP;
  -- 用窗口外的下一条序号证明没有漏过迟到/缺失事实，范围读取复用owner/time索引。
  SELECT * INTO next_change FROM knowledge.kb_metering_events
    WHERE owner_id = principal_owner AND event_type = 'capacity_change' AND occurred_at >= requested_end
    ORDER BY occurred_at, sequence LIMIT 1;
  IF FOUND THEN
    IF next_change.sequence <> closing_seq::numeric + 1 THEN RETURN 'VERSION_CONFLICT'; END IF;
  ELSIF closing_seq <> tail_change.sequence THEN RETURN 'VERSION_CONFLICT';
  END IF;
  total_byte_ms := total_byte_ms + running_bytes::numeric * (end_ms - cursor_ms);
  IF total_byte_ms < 0 OR total_byte_ms >= 1e38 THEN RETURN 'QUOTA_EXCEEDED'; END IF;

  IF replay_window THEN
    IF existing_window.quantity IS DISTINCT FROM total_byte_ms
       OR existing_window.opening_sequence IS DISTINCT FROM opening_seq
       OR existing_window.closing_sequence IS DISTINCT FROM closing_seq
       OR existing_window.event_set_hash IS DISTINCT FROM history_hash THEN
      RETURN 'VERSION_CONFLICT';
    END IF;
    RETURN 'REPLAY';
  END IF;
  event_key := 'storage:day:' || start_ms::text;
  IF EXISTS (SELECT 1 FROM knowledge.kb_metering_events
    WHERE owner_id = principal_owner AND logical_event_key = event_key) THEN
    RETURN 'VERSION_CONFLICT';
  END IF;

  INSERT INTO knowledge.kb_metering_events
    (owner_id, id, logical_event_key, event_type, dimension, unit, quantity, usage_source,
     subject_kind, subject_key, window_id, window_start, window_end,
     opening_sequence, closing_sequence, event_set_hash, tariff_revision, payer, occurred_at)
  VALUES (principal_owner, requested_window, event_key, 'observation', 'storage', 'byte_ms',
          total_byte_ms, 'reconciled', 'storage_window', requested_window::text,
          requested_window, requested_start, requested_end, opening_seq, closing_seq,
          history_hash, requested_tariff, 'customer', GREATEST(clock_timestamp(), requested_end));
  RETURN 'CLOSED';
END;
$function$;

REVOKE ALL ON FUNCTION knowledge.close_storage_window(uuid,timestamptz,timestamptz,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.close_storage_window(uuid,timestamptz,timestamptz,text)
  TO knowledge_worker;
