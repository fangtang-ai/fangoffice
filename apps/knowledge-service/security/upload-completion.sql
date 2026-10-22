CREATE FUNCTION knowledge.lock_upload_completion(requested_space uuid, requested_document uuid,
  requested_operation uuid, requested_generation bigint)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET row_security = on
AS $function$
DECLARE
  principal_owner text := NULLIF(current_setting('knowledge.owner_id', true), '');
  quota_row knowledge.kb_quotas%ROWTYPE;
  space_row knowledge.kb_spaces%ROWTYPE;
  document_row knowledge.kb_documents%ROWTYPE;
  operation_row knowledge.kb_operations%ROWTYPE;
BEGIN
  IF principal_owner IS NULL THEN RETURN 'UNAUTHENTICATED'; END IF;
  IF requested_space IS NULL OR requested_document IS NULL OR requested_operation IS NULL
     OR requested_generation IS NULL OR requested_generation < 0 THEN RETURN 'INVALID_REQUEST'; END IF;
  -- All completion, deletion and publication paths serialize on the same owner-first lock prefix.
  SELECT * INTO quota_row FROM knowledge.kb_quotas WHERE owner_id = principal_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF quota_row.owner_state <> 'active' THEN RETURN 'FORBIDDEN'; END IF;
  IF quota_row.policy_revision IS NULL OR quota_row.active_index_profile_id IS NULL
     OR quota_row.limit_files IS NULL OR quota_row.limit_bytes IS NULL OR quota_row.limit_chunks IS NULL
     THEN RETURN 'NOT_CONFIGURED'; END IF;
  SELECT * INTO space_row FROM knowledge.kb_spaces
    WHERE owner_id = principal_owner AND id = requested_space FOR SHARE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF space_row.state <> 'active' OR space_row.deleted_at IS NOT NULL THEN RETURN 'FORBIDDEN'; END IF;
  SELECT * INTO document_row FROM knowledge.kb_documents
    WHERE owner_id = principal_owner AND id = requested_document AND space_id = requested_space FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF document_row.deleted_at IS NOT NULL THEN RETURN 'FORBIDDEN'; END IF;
  SELECT * INTO operation_row FROM knowledge.kb_operations
    WHERE owner_id = principal_owner AND id = requested_operation AND document_id = requested_document FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF operation_row.kind <> 'upload' OR operation_row.expected_generation <> requested_generation
     THEN RETURN 'VERSION_CONFLICT'; END IF;
  IF operation_row.upload_job_id IS NOT NULL AND operation_row.target_version_id IS NOT NULL
     AND operation_row.phase IN ('queued','parsing','indexing','publishing','ready') THEN
    IF operation_row.phase <> 'ready' AND (document_row.generation <> requested_generation
       OR document_row.desired_operation_id IS DISTINCT FROM requested_operation
       OR document_row.desired_version_id IS DISTINCT FROM operation_row.target_version_id)
       THEN RETURN 'VERSION_CONFLICT'; END IF;
    RETURN 'REPLAY';
  END IF;
  IF operation_row.phase <> 'uploading' OR operation_row.target_version_id IS NOT NULL
     OR operation_row.upload_job_id IS NOT NULL OR document_row.generation <> requested_generation
     OR document_row.active_version_id IS NOT NULL OR document_row.active_build_id IS NOT NULL
     OR document_row.desired_operation_id IS DISTINCT FROM requested_operation
     OR document_row.desired_version_id IS NOT NULL
     OR operation_row.upload_expires_at IS NULL OR operation_row.upload_expires_at <= clock_timestamp()
     THEN RETURN 'VERSION_CONFLICT'; END IF;
  RETURN 'LOCKED';
END;
$function$;

CREATE FUNCTION knowledge.complete_upload(requested_space uuid, requested_document uuid,
  requested_operation uuid, requested_generation bigint, requested_version uuid,
  requested_bucket text, requested_key text, requested_hash bytea, requested_bytes bigint,
  requested_format text, requested_chunks bigint, requested_physical_bytes bigint,
  requested_expiry timestamptz, requested_queue text, requested_job uuid,
  requested_envelope jsonb, maximum_file_bytes bigint)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET row_security = on
AS $function$
DECLARE
  principal_owner text := NULLIF(current_setting('knowledge.owner_id', true), '');
  lock_status text;
  quota_row knowledge.kb_quotas%ROWTYPE;
  document_row knowledge.kb_documents%ROWTYPE;
  operation_row knowledge.kb_operations%ROWTYPE;
  version_row knowledge.kb_versions%ROWTYPE;
  reservation_row knowledge.kb_reservations%ROWTYPE;
  expected_mime text;
  job_data jsonb;
  staging_count bigint;
  missing_sizes bigint;
  pending_files bigint;
  pending_bytes numeric;
  staging_bytes numeric;
BEGIN
  IF principal_owner IS NULL THEN RETURN 'UNAUTHENTICATED'; END IF;
  IF maximum_file_bytes IS NULL OR maximum_file_bytes < 1 THEN RETURN 'NOT_CONFIGURED'; END IF;
  IF requested_bucket IS NULL OR requested_bucket !~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'
     OR requested_queue IS NULL OR requested_queue !~ '^[a-z][a-z0-9_]{0,62}$'
     OR requested_hash IS NULL OR octet_length(requested_hash) <> 32
     OR requested_bytes IS NULL OR requested_bytes < 1
     OR requested_format IS NULL OR requested_format NOT IN ('txt','md')
     OR requested_chunks IS NULL OR requested_chunks < 0
     OR requested_physical_bytes IS NULL OR requested_physical_bytes < requested_bytes
     OR requested_expiry IS NULL OR NOT isfinite(requested_expiry) THEN RETURN 'INVALID_REQUEST'; END IF;
  IF requested_bytes > maximum_file_bytes THEN RETURN 'QUOTA_EXCEEDED'; END IF;
  lock_status := knowledge.lock_upload_completion(requested_space, requested_document, requested_operation, requested_generation);
  IF lock_status NOT IN ('LOCKED','REPLAY') THEN RETURN lock_status; END IF;
  SELECT * INTO operation_row FROM knowledge.kb_operations WHERE owner_id = principal_owner AND id = requested_operation;
  IF operation_row.declared_bytes IS DISTINCT FROM requested_bytes
     OR operation_row.staging_key IS DISTINCT FROM 'staging/' || encode(sha256(convert_to(principal_owner,'UTF8')),'hex') || '/' || requested_operation::text
     OR requested_key IS DISTINCT FROM 'originals/' || encode(sha256(convert_to(principal_owner,'UTF8')),'hex') || '/' || requested_document::text || '/' || requested_operation::text
     OR operation_row.request_hash IS DISTINCT FROM sha256(convert_to(jsonb_build_object(
       'space',requested_space,'document',requested_document,'generation',requested_generation,
       'bytes',requested_bytes,'format',requested_format)::text,'UTF8')) THEN RETURN 'VERSION_CONFLICT'; END IF;
  expected_mime := CASE WHEN requested_format = 'txt' THEN 'text/plain' ELSE 'text/markdown' END;
  IF lock_status = 'REPLAY' THEN
    SELECT * INTO version_row FROM knowledge.kb_versions WHERE owner_id = principal_owner
      AND document_id = requested_document AND id = operation_row.target_version_id;
    IF NOT FOUND THEN RETURN 'VERSION_CONFLICT'; END IF;
    SELECT * INTO reservation_row FROM knowledge.kb_reservations
      WHERE owner_id = principal_owner AND operation_id = requested_operation FOR UPDATE;
    IF NOT FOUND THEN RETURN 'VERSION_CONFLICT'; END IF;
    -- Replay uses immutable committed facts, not a queue row that retention may already have removed.
    IF operation_row.upload_queue_name IS DISTINCT FROM requested_queue
       OR version_row.upload_operation_id <> requested_operation OR version_row.bucket <> requested_bucket
       OR version_row.oss_key <> requested_key OR version_row.file_hash <> requested_hash
       OR version_row.size_bytes <> requested_bytes OR version_row.format <> requested_format
       OR version_row.mime <> expected_mime OR version_row.gc_state <> 'live'
       OR version_row.purged_at IS NOT NULL
       OR reservation_row.document_id <> requested_document
       OR reservation_row.expected_generation <> requested_generation
       OR reservation_row.reserved_files <> 1 OR reservation_row.reserved_bytes <> requested_bytes
       OR reservation_row.reserved_chunks <> requested_chunks
       OR reservation_row.physical_reserved_bytes <> requested_physical_bytes
       OR reservation_row.expires_at <> requested_expiry THEN RETURN 'VERSION_CONFLICT'; END IF;
    RETURN 'REPLAY';
  END IF;
  IF requested_version IS NULL OR requested_job IS NULL OR requested_expiry <= clock_timestamp()
     OR jsonb_typeof(requested_envelope) IS DISTINCT FROM 'object' THEN RETURN 'INVALID_REQUEST'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(requested_envelope)) <> 4
     OR requested_envelope->>'ownerId' IS DISTINCT FROM principal_owner
     OR requested_envelope->>'operationId' IS DISTINCT FROM requested_operation::text
     OR (requested_envelope->>'buildId' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') IS NOT TRUE
     OR (requested_envelope->>'receiptId' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') IS NOT TRUE
     THEN RETURN 'INVALID_REQUEST'; END IF;
  SELECT * INTO quota_row FROM knowledge.kb_quotas WHERE owner_id = principal_owner;
  SELECT * INTO document_row FROM knowledge.kb_documents WHERE owner_id = principal_owner AND id = requested_document;
  SELECT * INTO reservation_row FROM knowledge.kb_reservations
    WHERE owner_id = principal_owner AND operation_id = requested_operation FOR UPDATE;
  IF FOUND OR document_row.next_version_no >= 9223372036854775807 THEN RETURN 'VERSION_CONFLICT'; END IF;
  -- Keep all retained staging debt, including expired/cancelled operations, in the physical bound.
  SELECT count(*), count(*) FILTER(WHERE declared_bytes IS NULL),
    count(*) FILTER(WHERE phase = 'uploading' AND id <> requested_operation),
    COALESCE(sum(declared_bytes) FILTER(WHERE phase = 'uploading' AND id <> requested_operation),0),
    COALESCE(sum(declared_bytes),0)
    INTO staging_count,missing_sizes,pending_files,pending_bytes,staging_bytes
    FROM (SELECT id,declared_bytes,phase FROM knowledge.kb_operations
      WHERE owner_id = principal_owner AND staging_key IS NOT NULL ORDER BY id LIMIT 1001) staged;
  IF staging_count > 1000 OR missing_sizes > 0
     OR quota_row.active_files::numeric + quota_row.reserved_files + pending_files + 1 > quota_row.limit_files
     OR quota_row.active_bytes::numeric + quota_row.reserved_bytes + pending_bytes + requested_bytes > quota_row.limit_bytes
     OR quota_row.active_chunks::numeric + quota_row.reserved_chunks + requested_chunks > quota_row.limit_chunks
     OR quota_row.physical_accounted_bytes::numeric + quota_row.physical_reserved_bytes + staging_bytes + requested_physical_bytes
       > quota_row.physical_limit_bytes THEN RETURN 'QUOTA_EXCEEDED'; END IF;
  -- Only a newly created reference-only job on this connection can be bound to the first completion.
  SELECT data INTO job_data FROM pgboss.job_common
    WHERE name = requested_queue AND id = requested_job AND state = 'created' AND retry_count = 0 FOR SHARE;
  IF NOT FOUND OR job_data IS DISTINCT FROM requested_envelope THEN RETURN 'VERSION_CONFLICT'; END IF;
  IF operation_row.upload_expires_at <= clock_timestamp() OR requested_expiry <= clock_timestamp()
     THEN RETURN 'VERSION_CONFLICT'; END IF;
  INSERT INTO knowledge.kb_versions(owner_id,document_id,id,version_no,upload_operation_id,
    bucket,oss_key,file_hash,size_bytes,format,mime,verified_at)
    VALUES(principal_owner,requested_document,requested_version,document_row.next_version_no,requested_operation,
      requested_bucket,requested_key,requested_hash,requested_bytes,requested_format,expected_mime,clock_timestamp());
  UPDATE knowledge.kb_operations SET phase = 'queued',target_version_id = requested_version,
    upload_job_id = requested_job,upload_queue_name = requested_queue,updated_at = clock_timestamp()
    WHERE owner_id = principal_owner AND id = requested_operation;
  INSERT INTO knowledge.kb_reservations(owner_id,operation_id,document_id,expected_generation,
    reserved_files,reserved_bytes,reserved_chunks,physical_reserved_bytes,expires_at)
    VALUES(principal_owner,requested_operation,requested_document,requested_generation,
      1,requested_bytes,requested_chunks,requested_physical_bytes,requested_expiry);
  UPDATE knowledge.kb_quotas SET reserved_files = reserved_files + 1,
    reserved_bytes = reserved_bytes + requested_bytes,reserved_chunks = reserved_chunks + requested_chunks,
    physical_reserved_bytes = physical_reserved_bytes + requested_physical_bytes,updated_at = clock_timestamp()
    WHERE owner_id = principal_owner;
  UPDATE knowledge.kb_documents SET desired_version_id = requested_version,
    next_version_no = next_version_no + 1,updated_at = clock_timestamp()
    WHERE owner_id = principal_owner AND id = requested_document;
  RETURN 'COMPLETED';
END;
$function$;

REVOKE ALL ON FUNCTION knowledge.lock_upload_completion(uuid,uuid,uuid,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION knowledge.complete_upload(uuid,uuid,uuid,bigint,uuid,text,text,bytea,bigint,text,bigint,bigint,timestamptz,text,uuid,jsonb,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.lock_upload_completion(uuid,uuid,uuid,bigint) TO knowledge_api;
GRANT EXECUTE ON FUNCTION knowledge.complete_upload(uuid,uuid,uuid,bigint,uuid,text,text,bytea,bigint,text,bigint,bigint,timestamptz,text,uuid,jsonb,bigint) TO knowledge_api;
