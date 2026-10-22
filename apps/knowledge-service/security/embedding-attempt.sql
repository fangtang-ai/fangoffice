-- D2只追加平台attempt成本事实；不把intent、unknown或pending事件当客户扣费授权。
CREATE FUNCTION knowledge.record_embedding_event(
  requested_event uuid, requested_attempt uuid, requested_state text,
  requested_source text, requested_quantity numeric, requested_previous uuid,
  requested_build uuid, requested_run uuid, requested_call uuid,
  requested_profile uuid, requested_purpose text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = on
AS $function$
DECLARE
  principal_owner text := NULLIF(current_setting('knowledge.owner_id', true), '');
  quota_row knowledge.kb_quotas%ROWTYPE;
  build_row knowledge.kb_builds%ROWTYPE;
  document_row knowledge.kb_documents%ROWTYPE;
  operation_row knowledge.kb_operations%ROWTYPE;
  reservation_row knowledge.kb_reservations%ROWTYPE;
  intent_row knowledge.kb_metering_events%ROWTYPE;
  previous_row knowledge.kb_metering_events%ROWTYPE;
  existing_row knowledge.kb_metering_events%ROWTYPE;
  candidate knowledge.kb_metering_events%ROWTYPE;
  lock_status text;
  intent_key text := 'embedding:intent:' || requested_attempt::text;
  ignored_fields text[] := ARRAY['occurred_at', 'created_at', 'delivery_state',
    'delivery_attempts', 'next_attempt_at', 'delivered_at'];
BEGIN
  IF principal_owner IS NULL THEN RETURN 'UNAUTHENTICATED'; END IF;
  IF requested_event IS NULL OR requested_attempt IS NULL OR requested_state IS NULL
     OR requested_state NOT IN ('intended', 'completed', 'failed', 'unknown', 'not_called')
     OR requested_source IS NULL OR requested_source NOT IN ('unknown', 'provider_reported', 'reconciled')
     OR (requested_source = 'unknown') <> (requested_quantity IS NULL)
     OR (requested_quantity IS NOT NULL AND
       (requested_quantity < 0 OR requested_quantity > 9223372036854775807
        OR requested_quantity <> trunc(requested_quantity)))
     OR (requested_state IN ('intended', 'unknown') AND requested_source <> 'unknown')
     OR (requested_state = 'not_called' AND
       (requested_source <> 'reconciled' OR requested_quantity IS DISTINCT FROM 0::numeric))
     OR (requested_previous IS NOT NULL AND
       (requested_state NOT IN ('completed', 'failed') OR requested_source = 'unknown')) THEN
    RETURN 'INVALID_REQUEST';
  END IF;
  IF requested_state = 'intended' THEN
    IF requested_previous IS NOT NULL OR requested_profile IS NULL OR requested_purpose IS NULL
       OR NOT ((requested_purpose = 'query' AND requested_build IS NULL
                AND requested_run IS NOT NULL AND requested_call IS NOT NULL)
         OR (requested_purpose IN ('document', 'user_rebuild', 'platform_rebuild')
             AND requested_build IS NOT NULL AND requested_run IS NULL AND requested_call IS NULL)) THEN
      RETURN 'INVALID_REQUEST';
    END IF;
  ELSIF requested_build IS NOT NULL OR requested_run IS NOT NULL OR requested_call IS NOT NULL
     OR requested_profile IS NOT NULL OR requested_purpose IS NOT NULL THEN
    RETURN 'INVALID_REQUEST';
  END IF;

  -- 与发布/取消/删除共享Quota首锁；等待后重读事实，外部调用永远在此短事务提交之后。
  SELECT * INTO quota_row FROM knowledge.kb_quotas
    WHERE owner_id = principal_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO intent_row FROM knowledge.kb_metering_events
    WHERE owner_id = principal_owner AND logical_event_key = intent_key;
  IF requested_state = 'intended' THEN
    IF FOUND THEN
      IF intent_row.id = requested_event AND intent_row.dimension = 'embedding'
         AND intent_row.call_state = 'intended' AND intent_row.attempt_id = requested_attempt
         AND intent_row.index_profile_id = requested_profile AND intent_row.purpose = requested_purpose
         AND intent_row.build_id IS NOT DISTINCT FROM requested_build
         AND intent_row.run_id IS NOT DISTINCT FROM requested_run
         AND intent_row.call_id IS NOT DISTINCT FROM requested_call THEN RETURN 'REPLAY'; END IF;
      RETURN 'VERSION_CONFLICT';
    END IF;
    IF quota_row.owner_state <> 'active' THEN RETURN 'FORBIDDEN'; END IF;
    IF quota_row.active_index_profile_id IS DISTINCT FROM requested_profile THEN RETURN 'FORBIDDEN'; END IF;
    candidate.owner_id := principal_owner;
    candidate.attempt_id := requested_attempt;
    candidate.index_profile_id := requested_profile;
    candidate.purpose := requested_purpose;
    candidate.subject_key := requested_attempt::text;
    candidate.logical_event_key := intent_key;
    IF requested_purpose = 'query' THEN
      -- query先于证据manifest生成；run/call由可信服务端生成，不能强造文件operation/build。
      candidate.subject_kind := 'query';
      candidate.run_id := requested_run;
      candidate.call_id := requested_call;
    ELSE
      SELECT * INTO build_row FROM knowledge.kb_builds
        WHERE owner_id = principal_owner AND id = requested_build;
      IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
      lock_status := knowledge.lock_build_lifecycle(principal_owner,
        build_row.document_id, build_row.operation_id, build_row.id);
      IF lock_status <> 'LOCKED' THEN RETURN lock_status; END IF;
      SELECT * INTO build_row FROM knowledge.kb_builds
        WHERE owner_id = principal_owner AND id = requested_build;
      SELECT * INTO document_row FROM knowledge.kb_documents
        WHERE owner_id = principal_owner AND id = build_row.document_id;
      SELECT * INTO operation_row FROM knowledge.kb_operations
        WHERE owner_id = principal_owner AND id = build_row.operation_id;
      SELECT * INTO reservation_row FROM knowledge.kb_reservations
        WHERE owner_id = principal_owner AND operation_id = build_row.operation_id;
      IF build_row.status <> 'building' OR build_row.gc_state <> 'live'
         OR build_row.index_profile_id <> requested_profile
         OR document_row.deleted_at IS NOT NULL
         OR document_row.desired_operation_id IS DISTINCT FROM build_row.operation_id
         OR document_row.desired_version_id IS DISTINCT FROM build_row.version_id
         OR document_row.generation <> build_row.expected_generation
         OR operation_row.phase NOT IN ('queued', 'parsing', 'indexing')
         OR reservation_row.state IS DISTINCT FROM 'held'
         OR reservation_row.expires_at <= clock_timestamp()
         OR NOT knowledge.has_current_build_attempt(principal_owner, requested_build)
         OR NOT EXISTS (SELECT 1 FROM knowledge.kb_spaces
           WHERE owner_id = principal_owner AND id = document_row.space_id AND state = 'active') THEN
        RETURN 'FORBIDDEN';
      END IF;
      candidate.subject_kind := 'operation';
      candidate.document_id := build_row.document_id;
      candidate.version_id := build_row.version_id;
      candidate.operation_id := build_row.operation_id;
      candidate.build_id := build_row.id;
    END IF;
  ELSE
    IF NOT FOUND OR intent_row.dimension <> 'embedding' OR intent_row.call_state <> 'intended'
       OR intent_row.attempt_id <> requested_attempt THEN RETURN 'NOT_FOUND'; END IF;
    -- 结果继承已提交intent的归属/profile/purpose；即使任务已失败或删除，也不能漏记真实供应商成本。
    candidate := intent_row;
    IF requested_previous IS NULL THEN
      candidate.logical_event_key := 'embedding:usage:' || requested_attempt::text;
    ELSE
      SELECT * INTO previous_row FROM knowledge.kb_metering_events
        WHERE owner_id = principal_owner AND id = requested_previous AND dimension = 'embedding'
          AND attempt_id = requested_attempt AND call_state <> 'intended';
      IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
      IF previous_row.call_state = 'not_called' THEN RETURN 'FORBIDDEN'; END IF;
      IF ROW(previous_row.subject_kind, previous_row.document_id, previous_row.version_id,
             previous_row.operation_id, previous_row.build_id, previous_row.run_id, previous_row.call_id,
             previous_row.index_profile_id, previous_row.purpose)
         IS DISTINCT FROM ROW(intent_row.subject_kind, intent_row.document_id, intent_row.version_id,
             intent_row.operation_id, intent_row.build_id, intent_row.run_id, intent_row.call_id,
             intent_row.index_profile_id, intent_row.purpose) THEN RETURN 'VERSION_CONFLICT'; END IF;
      candidate.logical_event_key := 'embedding:correction:' || requested_event::text;
    END IF;
  END IF;

  candidate.id := requested_event;
  candidate.event_type := CASE WHEN requested_previous IS NULL THEN 'observation' ELSE 'correction' END;
  candidate.supersedes_event_id := requested_previous;
  candidate.dimension := 'embedding';
  candidate.unit := 'tokens';
  candidate.quantity := requested_quantity;
  candidate.usage_source := requested_source;
  candidate.call_state := requested_state;
  candidate.completion := 'none';
  candidate.payer := 'platform';
  candidate.tariff_revision := NULL;
  candidate.schema_version := 1;
  candidate.occurred_at := GREATEST(clock_timestamp(), intent_row.occurred_at, previous_row.occurred_at);
  SELECT * INTO existing_row FROM knowledge.kb_metering_events
    WHERE owner_id = principal_owner AND id = requested_event;
  IF FOUND THEN
    IF (to_jsonb(existing_row) - ignored_fields) = (to_jsonb(candidate) - ignored_fields) THEN RETURN 'REPLAY'; END IF;
    RETURN 'VERSION_CONFLICT';
  END IF;
  IF EXISTS (SELECT 1 FROM knowledge.kb_metering_events WHERE owner_id = principal_owner
      AND logical_event_key = candidate.logical_event_key) THEN RETURN 'VERSION_CONFLICT'; END IF;
  -- 同一usage链只有一个后继；旧叶不能分叉，历史更正的精确重放则在上方先返回。
  IF requested_previous IS NOT NULL AND EXISTS (SELECT 1 FROM knowledge.kb_metering_events
    WHERE owner_id = principal_owner AND dimension = 'embedding' AND event_type = 'correction'
      AND supersedes_event_id = requested_previous) THEN RETURN 'VERSION_CONFLICT'; END IF;
  INSERT INTO knowledge.kb_metering_events
    (owner_id,id,logical_event_key,event_type,supersedes_event_id,dimension,unit,quantity,usage_source,
     subject_kind,subject_key,document_id,version_id,operation_id,build_id,run_id,call_id,
     attempt_id,index_profile_id,purpose,call_state,completion,tariff_revision,payer,schema_version,occurred_at)
  VALUES (candidate.owner_id,candidate.id,candidate.logical_event_key,candidate.event_type,
     candidate.supersedes_event_id,candidate.dimension,candidate.unit,candidate.quantity,candidate.usage_source,
     candidate.subject_kind,candidate.subject_key,candidate.document_id,candidate.version_id,
     candidate.operation_id,candidate.build_id,candidate.run_id,candidate.call_id,candidate.attempt_id,
     candidate.index_profile_id,candidate.purpose,candidate.call_state,candidate.completion,
     candidate.tariff_revision,candidate.payer,candidate.schema_version,candidate.occurred_at);
  RETURN 'RECORDED';
END;
$function$;
REVOKE ALL ON FUNCTION knowledge.record_embedding_event(uuid,uuid,text,text,numeric,uuid,uuid,uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.record_embedding_event(uuid,uuid,text,text,numeric,uuid,uuid,uuid,uuid,uuid,text) TO knowledge_worker;
