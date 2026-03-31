import Facturapi from "facturapi";

// Global Facturapi client (user-level key for managing organizations)
export const facturapiAdmin = new Facturapi(
  process.env.FACTURAPI_SECRET_KEY!
);

// Per-company Facturapi client using the company's own API key
export function getFacturapiClient(companyApiKey: string) {
  return new Facturapi(companyApiKey);
}
