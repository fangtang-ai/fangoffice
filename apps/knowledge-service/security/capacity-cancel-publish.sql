-- 取消门的事实查询独立为SQL函数，避免PL/pgSQL行变量operation与表别名冲突。
-- 不修改已经应用的capacity-cancel增量，历史制品和回执仍可逐项核验。
CREATE FUNCTION knowledge.has_cancelled_reservation(
  requested_owner text, requested_document uuid, requested_operation uuid,
  requested_version uuid, requested_generation bigint
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM knowledge.kb_operations pending
    JOIN knowledge.kb_reservations reservation ON reservation.owner_id = pending.owner_id
      AND reservation.operation_id = pending.id
    WHERE pending.owner_id = requested_owner AND pending.id = requested_operation
      AND pending.document_id = requested_document AND pending.target_version_id = requested_version
      AND pending.expected_generation = requested_generation AND pending.phase = 'cancelled'
      AND pending.kind IN ('upload', 'replace') AND reservation.document_id = requested_document
      AND reservation.expected_generation = requested_generation AND reservation.state = 'released'
      AND reservation.closed_at IS NOT NULL
  ) AND NOT EXISTS (
    SELECT 1 FROM knowledge.kb_builds
    WHERE owner_id = requested_owner AND operation_id = requested_operation
      AND status IN ('building', 'sealed')
  );
$function$;
REVOKE ALL ON FUNCTION knowledge.has_cancelled_reservation(text, uuid, uuid, uuid, bigint) FROM PUBLIC;

CREATE OR REPLACE FUNCTION knowledge.guard_document_publish()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  build knowledge.kb_builds%ROWTYPE;
  operation knowledge.kb_operations%ROWTYPE;
  space knowledge.kb_spaces%ROWTYPE;
  quota knowledge.kb_quotas%ROWTYPE;
BEGIN
  IF (NEW.active_version_id, NEW.active_build_id, NEW.generation)
     IS NOT DISTINCT FROM (OLD.active_version_id, OLD.active_build_id, OLD.generation) THEN
    RETURN NEW;
  END IF;

  -- 只有窄取消definer在已关闭预留、封停writer之后可推进代数而保留active。
  -- 运行角色不能借用GUC、单改generation或重开已取消的operation绕过发布条件。
  IF current_user = 'knowledge_migrator'
     AND (NEW.active_version_id, NEW.active_build_id)
         IS NOT DISTINCT FROM (OLD.active_version_id, OLD.active_build_id)
     AND NEW.generation = OLD.generation + 1
     AND OLD.desired_operation_id IS NOT NULL AND OLD.desired_version_id IS NOT NULL
     AND NEW.desired_operation_id IS NULL AND NEW.desired_version_id IS NULL
     AND (to_jsonb(NEW) - ARRAY['desired_operation_id', 'desired_version_id', 'generation', 'updated_at'])
         IS NOT DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['desired_operation_id', 'desired_version_id', 'generation', 'updated_at'])
     AND knowledge.has_cancelled_reservation(
       OLD.owner_id, OLD.id, OLD.desired_operation_id, OLD.desired_version_id, OLD.generation
     ) THEN
    RETURN NEW;
  END IF;

  IF (NEW.active_version_id, NEW.active_build_id)
     IS NOT DISTINCT FROM (OLD.active_version_id, OLD.active_build_id)
     OR NEW.generation <> OLD.generation + 1
     OR (NEW.title, NEW.purpose, NEW.tags, NEW.space_id, NEW.next_version_no,
         NEW.deleted_at, NEW.created_at)
        IS DISTINCT FROM
        (OLD.title, OLD.purpose, OLD.tags, OLD.space_id, OLD.next_version_no,
         OLD.deleted_at, OLD.created_at) THEN
    RAISE EXCEPTION 'Active pointer changes must publish the desired build'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_document_publish_gate';
  END IF;
  IF OLD.desired_operation_id IS NULL OR OLD.desired_version_id IS NULL THEN
    RAISE EXCEPTION 'Publication requires a pending desired operation'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_document_publish_gate';
  END IF;
  SELECT * INTO quota FROM knowledge.kb_quotas WHERE owner_id = OLD.owner_id;
  IF NOT FOUND OR quota.owner_state <> 'active' THEN
    RAISE EXCEPTION 'Publication requires an active owner'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_document_publish_gate';
  END IF;
  SELECT * INTO space FROM knowledge.kb_spaces
    WHERE owner_id = OLD.owner_id AND id = OLD.space_id;
  IF NOT FOUND OR space.state <> 'active' OR space.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Publication requires an active space'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_document_publish_gate';
  END IF;
  SELECT * INTO build FROM knowledge.kb_builds
    WHERE owner_id = OLD.owner_id AND id = NEW.active_build_id;
  IF NOT FOUND OR build.document_id <> OLD.id
     OR build.version_id IS DISTINCT FROM NEW.active_version_id
     OR build.operation_id IS DISTINCT FROM OLD.desired_operation_id
     OR build.version_id IS DISTINCT FROM OLD.desired_version_id
     OR build.status <> 'sealed' OR build.sealed_at IS NULL
     OR build.gc_state <> 'live' OR build.purged_at IS NOT NULL
     OR build.expected_generation <> OLD.generation
     OR build.index_profile_id IS DISTINCT FROM quota.active_index_profile_id THEN
    RAISE EXCEPTION 'Publication requires the desired sealed build at the current generation'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_document_publish_gate';
  END IF;
  SELECT * INTO operation FROM knowledge.kb_operations
    WHERE owner_id = OLD.owner_id AND id = OLD.desired_operation_id;
  IF NOT FOUND OR operation.kind NOT IN ('upload', 'replace', 'rebuild')
     OR operation.phase NOT IN ('indexing', 'publishing') THEN
    RAISE EXCEPTION 'Publication requires the desired operation inside the publish window'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_document_publish_gate';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION knowledge.guard_document_publish() FROM PUBLIC;
