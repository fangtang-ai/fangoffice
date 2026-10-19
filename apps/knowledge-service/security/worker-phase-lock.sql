-- phase直写同样能先持Operation再倒锁Quota；发布已走definer，无需保留此旁路。
CREATE OR REPLACE FUNCTION knowledge.guard_build_cancel_fence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF current_user = 'knowledge_worker' THEN
    IF knowledge.lock_build_lifecycle(NEW.owner_id, NEW.document_id, NEW.operation_id, NULL) <> 'LOCKED' THEN
      RAISE EXCEPTION 'Build claim requires its locked owner and operation'
        USING ERRCODE = '23514', CONSTRAINT = 'kb_build_cancel_fence';
    END IF;
    -- definer已按父锁序锁定Operation，不再依赖worker的phase列UPDATE权限。
    PERFORM id FROM knowledge.kb_operations
      WHERE owner_id = NEW.owner_id AND id = NEW.operation_id
        AND phase IN ('queued', 'parsing', 'indexing');
  ELSE
    PERFORM id FROM knowledge.kb_operations
      WHERE owner_id = NEW.owner_id AND id = NEW.operation_id
        AND phase IN ('queued', 'parsing', 'indexing') FOR SHARE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Build claim requires an uncancelled operation'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_build_cancel_fence';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION knowledge.guard_build_cancel_fence() FROM PUBLIC;
REVOKE UPDATE (phase) ON knowledge.kb_operations FROM knowledge_worker;
