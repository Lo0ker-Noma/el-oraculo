// Carga variables desde <proyecto>/.env (si existe) ANTES de que ningun otro
// modulo lea process.env. Debe importarse EL PRIMERO en server.js.
import path from "node:path";
import { fileURLToPath } from "node:url";

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
try {
  process.loadEnvFile(envPath);
  console.log("[env] .env cargado");
} catch {
  // sin .env -> modo demo (pagos y veredicto simulados)
}
