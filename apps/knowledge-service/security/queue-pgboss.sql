-- B4 队列协议验证的运行时授权边界。pgboss 模式由独立的维护入口
-- （integration/apply-queue-local.mjs，以 knowledge_migrator 身份运行固定版本
-- pg-boss 12.37.1 自建自迁移）安装并持有所有权；本迁移只收窄 PUBLIC 并
-- 授予运行时角色已被证明需要的最小语句面。
-- 维护面（模式 DDL、队列管理、instance 注册表、删除）不授予运行时角色；
-- migrate: false 不构成最小权限证据，见 security/README.md。

REVOKE ALL ON SCHEMA pgboss FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA pgboss FROM PUBLIC;

GRANT USAGE ON SCHEMA pgboss TO knowledge_api, knowledge_worker;

-- v12.37 运行时语句（send/fetch/complete/fail/touch）经 queue.table_name
-- 直达非分区队列的具体存储表 job_common（plans.js:919 将其作为默认分区
-- ATTACH 到父表 job）；父表 job 本身不在任何运行时语句面上，不授予。
-- api 入队：send() 对 job_common 做 INSERT ... RETURNING id，
-- 并读取队列行以解析策略默认值。
GRANT SELECT, INSERT ON pgboss.job_common TO knowledge_api;
GRANT SELECT ON pgboss.queue TO knowledge_api;

-- worker 认领/结算/心跳：fetch 以 UPDATE 抢占，complete/fail 以 UPDATE/INSERT 结算，
-- fail 先 DELETE 旧行再 INSERT 重试行（同一语句 CTE），并经队列行 JOIN 解析死信策略。
GRANT SELECT, INSERT, UPDATE, DELETE ON pgboss.job_common TO knowledge_worker;
GRANT SELECT ON pgboss.queue TO knowledge_worker;

-- fail() 的死信 CTE 恒定引用父表 job（plans.js:3009 INSERT INTO ${schema}.job），
-- 即使本队列 dead_letter 为 NULL（零行也会在执行器初始化时做 ACL 检查），
-- 因此 worker 对父表只有 INSERT。
GRANT INSERT ON pgboss.job TO knowledge_worker;

-- 维护面表（instance/schedule/queue_stats/subscription/version/warning/bam/
-- job_dependency）对运行时角色不授任何权限。

-- 回放护栏探针：applyLocalGate 用 to_regprocedure 检查该签名存在。
CREATE FUNCTION pgboss.guard_queue_access()
RETURNS void
LANGUAGE sql
AS $function$
  SELECT NULL::void;
$function$;
