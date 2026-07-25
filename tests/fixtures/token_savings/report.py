# Synthetic fixture for the token-savings regression benchmark.
# Deliberately padded with several unrelated functions/classes so the full
# file is much larger than any single symbol a surgical read would return.

from dataclasses import dataclass, field


@dataclass
class LineItem:
    sku: str
    quantity: int
    unit_price: float


@dataclass
class Invoice:
    invoice_id: str
    customer: str
    items: list = field(default_factory=list)


def add_line_item(invoice, sku, quantity, unit_price):
    invoice.items.append(LineItem(sku, quantity, unit_price))
    return invoice


def remove_line_item(invoice, sku):
    invoice.items = [item for item in invoice.items if item.sku != sku]
    return invoice


def subtotal(invoice):
    return sum(item.quantity * item.unit_price for item in invoice.items)


def apply_discount(amount, percent):
    if percent < 0 or percent > 100:
        raise ValueError("percent must be between 0 and 100")
    return amount * (1 - percent / 100)


def calculate_total(invoice, tax_rate=0.0, discount_percent=0.0):
    """Compute the final total for an invoice.

    This is the target symbol for the token-savings benchmark's
    `symbol`/`read` measurements -- a small, self-contained function
    inside a much larger file.
    """
    base = subtotal(invoice)
    discounted = apply_discount(base, discount_percent)
    return discounted * (1 + tax_rate)


def format_currency(amount, symbol="$"):
    return f"{symbol}{amount:,.2f}"


def group_items_by_sku(invoices):
    grouped = {}
    for invoice in invoices:
        for item in invoice.items:
            grouped.setdefault(item.sku, 0)
            grouped[item.sku] += item.quantity
    return grouped


class InvoiceBook:
    def __init__(self):
        self._invoices = {}

    def add(self, invoice):
        self._invoices[invoice.invoice_id] = invoice

    def get(self, invoice_id):
        return self._invoices.get(invoice_id)

    def all(self):
        return list(self._invoices.values())

    def total_revenue(self, tax_rate=0.0):
        return sum(calculate_total(inv, tax_rate) for inv in self.all())


def month_end_summary(book, tax_rate=0.0):
    lines = []
    for invoice in book.all():
        total = calculate_total(invoice, tax_rate)
        lines.append(f"{invoice.invoice_id}: {format_currency(total)}")
    return "\n".join(lines)


def validate_invoice(invoice):
    if not invoice.items:
        raise ValueError(f"invoice {invoice.invoice_id} has no line items")
    for item in invoice.items:
        if item.quantity <= 0:
            raise ValueError(f"invalid quantity for {item.sku}")
        if item.unit_price < 0:
            raise ValueError(f"invalid unit price for {item.sku}")
    return True
