CREATE FUNCTION knowledge.guard_build_content()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  parent knowledge.kb_builds%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Build content is append-only'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_build_content_immutable';
  END IF;

  -- SHARE conflicts with non-key state updates; KEY SHARE would admit a seal race.
  SELECT * INTO parent FROM knowledge.kb_builds
    WHERE owner_id = NEW.owner_id AND id = NEW.build_id FOR SHARE;
  IF NOT FOUND OR parent.status <> 'building' OR parent.gc_state <> 'live'
     OR parent.sealed_at IS NOT NULL OR parent.manifest IS NOT NULL
     OR parent.manifest_hash IS NOT NULL THEN
    RAISE EXCEPTION 'Build is not open for content insertion'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_build_writable';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION knowledge.guard_build_content() FROM PUBLIC;

CREATE FUNCTION knowledge.guard_build_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Build deletion requires a separately authorized GC path'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_build_frozen';
  END IF;
  IF (OLD.status <> 'building' AND NEW.status = 'building')
     OR (OLD.status IN ('invalidated', 'purged') AND NEW.status = 'sealed')
     OR (OLD.status = 'purged' AND NEW.status <> 'purged')
     OR (OLD.gc_state <> 'live' AND NEW.gc_state = 'live') THEN
    RAISE EXCEPTION 'Closed build cannot be reopened'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_build_frozen';
  END IF;

  -- Once sealed, only revocation/GC metadata may change, never the sealed snapshot.
  IF OLD.sealed_at IS NOT NULL AND
     (to_jsonb(NEW) - ARRAY['status', 'gc_state', 'purged_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'gc_state', 'purged_at']) THEN
    RAISE EXCEPTION 'Sealed build facts cannot be replaced'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_build_frozen';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION knowledge.guard_build_state() FROM PUBLIC;

CREATE TRIGGER kb_build_identity BEFORE UPDATE ON knowledge.kb_builds
FOR EACH ROW EXECUTE FUNCTION knowledge.guard_immutable_facts(
  'status', 'manifest', 'manifest_hash', 'source_unit_count', 'chunk_count',
  'embedding_count', 'sealed_at', 'gc_state', 'purged_at'
);

CREATE TRIGGER kb_build_state BEFORE UPDATE OR DELETE ON knowledge.kb_builds
FOR EACH ROW EXECUTE FUNCTION knowledge.guard_build_state();

CREATE TRIGGER kb_build_content BEFORE INSERT OR UPDATE OR DELETE ON knowledge.kb_source_units
FOR EACH ROW EXECUTE FUNCTION knowledge.guard_build_content();
CREATE TRIGGER kb_build_content BEFORE INSERT OR UPDATE OR DELETE ON knowledge.kb_chunks
FOR EACH ROW EXECUTE FUNCTION knowledge.guard_build_content();
CREATE TRIGGER kb_build_content BEFORE INSERT OR UPDATE OR DELETE ON knowledge.kb_chunk_sources
FOR EACH ROW EXECUTE FUNCTION knowledge.guard_build_content();
CREATE TRIGGER kb_build_content BEFORE INSERT OR UPDATE OR DELETE ON knowledge.kb_chunk_embeddings
FOR EACH ROW EXECUTE FUNCTION knowledge.guard_build_content();
