declare module "facturapi" {
  // ── Invoice ────────────────────────────────────────────────────────────────

  interface FacturapiInvoiceItem {
    quantity: number;
    /**
     * Cuenta(s) predial(es) del inmueble arrendado — nodo CuentaPredial del
     * concepto en CFDI 4.0. Va en la PARTIDA, no en el producto, y es arreglo
     * porque un concepto puede amparar varias cuentas catastrales.
     */
    property_tax_account?: string[];
    product: {
      description: string;
      product_key: string;
      price: number;
      unit_key?: string;
      tax_included?: boolean;
      taxes?: Array<{
        type: string;
        rate: number;
        factor: string;
        withholding?: boolean;
      }>;
    };
  }

  interface FacturapiInvoiceGlobal {
    periodicity: "day" | "week" | "fortnight" | "month" | "two_months";
    months: string;  // "01"–"12" for monthly, "01"–"06" bimestral, etc.
    year: number;
  }

  interface FacturapiCreateInvoiceOptions {
    customer: string;
    payment_form: string;
    payment_method: string;
    use: string;
    items: FacturapiInvoiceItem[];
    pdf_custom_section?: string;
    global?: FacturapiInvoiceGlobal;
    /** "draft" creates a borrador (no stamp/timbre consumed) for preview. */
    status?: "draft";
  }

  interface FacturapiInvoice {
    id: string;
    uuid: string;
    subtotal: number;
    total: number;
    status: string;
    folio_number?: number;
    pdf_custom_section?: string;
  }

  // ── Customer ───────────────────────────────────────────────────────────────

  interface FacturapiCustomerAddress {
    zip: string;
    street?: string;
    exterior?: string;
  }

  interface FacturapiCreateCustomerOptions {
    legal_name: string;
    tax_id: string;
    tax_system: string;
    email?: string;
    phone?: string;
    address: FacturapiCustomerAddress;
  }

  interface FacturapiCustomer {
    id: string;
    legal_name: string;
    tax_id: string;
  }

  // ── Organization ───────────────────────────────────────────────────────────

  interface FacturapiOrganizationLegal {
    name: string;
    legal_name?: string;
    tax_id?: string;           // RFC
    tax_system?: string;       // Régimen fiscal
    website?: string;
    phone?: string;
    address?: {
      zip: string;
      street?: string;
      exterior?: string;
      interior?: string;
      neighborhood?: string;
      city?: string;
      municipality?: string;
      state?: string;
      country?: string;
    };
  }

  interface FacturapiOrganization {
    id: string;
    created_at: string;
    name: string;
    legal: FacturapiOrganizationLegal;
    certificate_valid_at?: string;
    is_production_ready?: boolean;
  }

  interface FacturapiApiKey {
    api_key: string;
  }

  interface FacturapiCertificate {
    expires_at: string;
    updated_at: string;
  }

  // ── Main class ─────────────────────────────────────────────────────────────

  class Facturapi {
    constructor(apiKey: string);

    invoices: {
      create(options: FacturapiCreateInvoiceOptions): Promise<FacturapiInvoice>;
      cancel(id: string): Promise<FacturapiInvoice>;
      retrieve(id: string): Promise<FacturapiInvoice>;
      /** Promotes a "draft" invoice to a stamped CFDI (consumes one timbre). */
      stampDraft(id: string, params?: object): Promise<FacturapiInvoice>;
      editDraft(id: string, data: Partial<FacturapiCreateInvoiceOptions>): Promise<FacturapiInvoice>;
      downloadPdf(id: string): Promise<NodeJS.ReadableStream>;
      downloadXml(id: string): Promise<NodeJS.ReadableStream>;
      /** Envía la factura (PDF+XML) por correo; sin `email` usa el del cliente. */
      sendByEmail(id: string, data?: { email?: string }): Promise<unknown>;
    };

    customers: {
      create(options: FacturapiCreateCustomerOptions): Promise<FacturapiCustomer>;
      update(id: string, options: Partial<FacturapiCreateCustomerOptions>): Promise<FacturapiCustomer>;
    };

    organizations: {
      create(data: { name: string }): Promise<FacturapiOrganization>;
      list(params?: object): Promise<{ data: FacturapiOrganization[] }>;
      retrieve(id: string): Promise<FacturapiOrganization>;
      updateLegal(id: string, data: Partial<FacturapiOrganizationLegal>): Promise<FacturapiOrganization>;
      uploadCertificate(
        id: string,
        cerFile: Buffer | NodeJS.ReadableStream,
        keyFile: Buffer | NodeJS.ReadableStream,
        password: string
      ): Promise<FacturapiCertificate>;
      deleteCertificate(id: string): Promise<void>;
      getTestApiKey(id: string): Promise<FacturapiApiKey>;
      renewTestApiKey(id: string): Promise<FacturapiApiKey>;
      renewLiveApiKey(id: string): Promise<FacturapiApiKey>;
      del(id: string): Promise<void>;
    };
  }

  export default Facturapi;
}
