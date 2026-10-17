import {
  adminSessionCookie,
  currentAdmin,
} from "./admin-auth.js";
import {
  currentEmployee,
  employeeSessionCookie,
} from "./employee-auth.js";

export async function currentCatalogActor(request) {
  const adminToken = request.cookies.get(adminSessionCookie)?.value;
  if (adminToken) {
    const admin = await currentAdmin(adminToken);
    if (admin) return { account: admin.account, sourceSystem: "admin" };
  }

  const employeeToken = request.cookies.get(employeeSessionCookie)?.value;
  if (!employeeToken) return null;

  const employee = await currentEmployee(employeeToken);
  return employee ? { account: employee.account, sourceSystem: "employee" } : null;
}

export async function hasCatalogSession(request) {
  return Boolean(await currentCatalogActor(request));
}
