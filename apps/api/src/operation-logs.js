export async function writeOperationLog(client, {
  actor,
  operationType,
  targetType,
  targetId,
  content,
}) {
  const actorResult = actor.sourceSystem === "admin"
    ? await client.query("SELECT id, display_name FROM admin_accounts WHERE account = $1", [actor.account])
    : await client.query("SELECT id, display_name FROM employee_accounts WHERE account = $1", [actor.account]);
  const actorIdentity = actorResult.rows[0];
  const actorId = actorIdentity.id;

  await client.query(
    `INSERT INTO system_operation_logs (
       actor_admin_account_id, actor_employee_account_id,
       actor_account_snapshot, actor_display_name_snapshot, source_system,
       operation_type, target_type, target_id, operation_content
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      actor.sourceSystem === "admin" ? actorId : null,
      actor.sourceSystem === "employee" ? actorId : null,
      actor.account,
      actorIdentity.display_name,
      actor.sourceSystem,
      operationType,
      targetType,
      targetId,
      content,
    ],
  );
}
