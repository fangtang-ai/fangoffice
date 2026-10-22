DO $migration$
DECLARE
  definition text := pg_get_functiondef('knowledge.apply_deletion_intent(text,text,uuid,uuid)'::regprocedure);
  original text := $before$    IF scope_kind <> 'document' THEN
      UPDATE knowledge.kb_spaces$before$;
  replacement text := $after$    IF scope_kind <> 'document' THEN
      now_at := GREATEST(now_at, clock_timestamp());
      UPDATE knowledge.kb_spaces$after$;
BEGIN
  -- Empty spaces bypass the document clock; preserve all accounting and permission gates.
  IF length(definition) - length(replace(definition, original, '')) <> length(original)
     OR position(replacement IN definition) > 0 THEN
    RAISE EXCEPTION 'Refusing an unexpected or already patched deletion definition';
  END IF;
  EXECUTE replace(definition, original, replacement);
END;
$migration$;
