-- 触发器表达式在选择取消分支之前也会检查所引用函数的EXECUTE权限。
-- worker只获得同一RLS视界内的纯事实查询，不获得取消写入口或新底表写权。
GRANT EXECUTE ON FUNCTION knowledge.has_cancelled_reservation(text, uuid, uuid, uuid, bigint)
  TO knowledge_worker;
