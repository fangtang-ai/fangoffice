CREATE FUNCTION knowledge.guard_immutable_facts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Immutable knowledge facts cannot be deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_immutable_facts';
  END IF;

  -- Excluding only explicitly mutable fields also freezes future fact columns by default.
  IF (to_jsonb(NEW) - COALESCE(TG_ARGV, ARRAY[]::text[]))
     IS DISTINCT FROM (to_jsonb(OLD) - COALESCE(TG_ARGV, ARRAY[]::text[])) THEN
    RAISE EXCEPTION 'Immutable knowledge facts cannot be replaced'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_immutable_facts';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION knowledge.guard_immutable_facts() FROM PUBLIC;

CREATE TRIGGER kb_immutable_facts
BEFORE UPDATE OR DELETE ON knowledge.kb_index_profiles
FOR EACH ROW EXECUTE FUNCTION knowledge.guard_immutable_facts();

CREATE TRIGGER kb_immutable_facts
BEFORE UPDATE OR DELETE ON knowledge.kb_versions
FOR EACH ROW EXECUTE FUNCTION knowledge.guard_immutable_facts(
  'retain_until', 'gc_state', 'purged_at'
);

CREATE TRIGGER kb_immutable_facts
BEFORE UPDATE OR DELETE ON knowledge.kb_metering_events
FOR EACH ROW EXECUTE FUNCTION knowledge.guard_immutable_facts(
  'delivery_state', 'delivery_attempts', 'next_attempt_at', 'delivered_at'
);

CREATE TRIGGER kb_immutable_facts
BEFORE UPDATE OR DELETE ON knowledge.kb_billing_receipts
FOR EACH ROW EXECUTE FUNCTION knowledge.guard_immutable_facts(
  'status', 'site_receipt_id', 'confirmed_at', 'site_amounts',
  'reconciled_at', 'next_reconcile_at', 'updated_at'
);
