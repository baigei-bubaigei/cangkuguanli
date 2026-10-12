import {
  adminSessionCookie,
  currentAdmin,
} from "./admin-auth.js";
import {
  currentEmployee,
  employeeSessionCookie,
} from "./employee-auth.js";

export async function hasCatalogSession(request) {
  const adminToken = request.cookies.get(adminSessionCookie)?.value;
  if (adminToken && await currentAdmin(adminToken)) return true;

  const employeeToken = request.cookies.get(employeeSessionCookie)?.value;
  return Boolean(employeeToken && await currentEmployee(employeeToken));
}
