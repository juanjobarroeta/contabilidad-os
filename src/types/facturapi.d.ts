declare module "facturapi" {
  interface FacturapiInvoiceItem {
    quantity: number;
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

  interface FacturapiCreateInvoiceOptions {
    customer: string;
    payment_form: string;
    payment_method: string;
    use: string;
    items: FacturapiInvoiceItem[];
    pdf_custom_section?: string;
  }

  interface FacturapiInvoice {
    id: string;
    uuid: string;
    subtotal: number;
    total: number;
    status: string;
    pdf_custom_section?: string;
  }

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

  class Facturapi {
    constructor(apiKey: string);
    invoices: {
      create(options: FacturapiCreateInvoiceOptions): Promise<FacturapiInvoice>;
      cancel(id: string): Promise<FacturapiInvoice>;
    };
    customers: {
      create(options: FacturapiCreateCustomerOptions): Promise<FacturapiCustomer>;
      update(id: string, options: Partial<FacturapiCreateCustomerOptions>): Promise<FacturapiCustomer>;
    };
  }

  export default Facturapi;
}
