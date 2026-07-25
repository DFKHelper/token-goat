// Synthetic fixture for the token-savings regression benchmark.
// A larger file with many small functions, used to measure `outline`
// savings (a symbol-signature listing vs. the full file body).
package inventory

import (
	"errors"
	"fmt"
	"sync"
)

// Item represents a single stock-keeping unit tracked by the warehouse.
type Item struct {
	SKU      string
	Name     string
	Quantity int
	Price    float64
}

// Warehouse holds items behind a mutex for concurrent access.
type Warehouse struct {
	mu    sync.Mutex
	items map[string]*Item
}

// NewWarehouse constructs an empty Warehouse.
func NewWarehouse() *Warehouse {
	return &Warehouse{items: make(map[string]*Item)}
}

// AddItem inserts a new item, erroring if the SKU already exists.
func (w *Warehouse) AddItem(item *Item) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, ok := w.items[item.SKU]; ok {
		return fmt.Errorf("item already exists: %s", item.SKU)
	}
	w.items[item.SKU] = item
	return nil
}

// RemoveItem deletes an item by SKU.
func (w *Warehouse) RemoveItem(sku string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, ok := w.items[sku]; !ok {
		return errors.New("item not found")
	}
	delete(w.items, sku)
	return nil
}

// GetItem returns a copy of the item, if present.
func (w *Warehouse) GetItem(sku string) (*Item, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	item, ok := w.items[sku]
	return item, ok
}

// IncrementStock adds delta units to an item's quantity.
func (w *Warehouse) IncrementStock(sku string, delta int) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	item, ok := w.items[sku]
	if !ok {
		return errors.New("item not found")
	}
	item.Quantity += delta
	return nil
}

// DecrementStock subtracts delta units, erroring on insufficient stock.
func (w *Warehouse) DecrementStock(sku string, delta int) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	item, ok := w.items[sku]
	if !ok {
		return errors.New("item not found")
	}
	if item.Quantity < delta {
		return fmt.Errorf("insufficient stock for %s: have %d, want %d", sku, item.Quantity, delta)
	}
	item.Quantity -= delta
	return nil
}

// TotalValue sums quantity*price across all items.
func (w *Warehouse) TotalValue() float64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	total := 0.0
	for _, item := range w.items {
		total += float64(item.Quantity) * item.Price
	}
	return total
}

// LowStockItems returns SKUs at or below the given threshold.
func (w *Warehouse) LowStockItems(threshold int) []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	var skus []string
	for sku, item := range w.items {
		if item.Quantity <= threshold {
			skus = append(skus, sku)
		}
	}
	return skus
}

// ItemCount returns the number of distinct SKUs tracked.
func (w *Warehouse) ItemCount() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.items)
}

// Reprice updates an item's unit price.
func (w *Warehouse) Reprice(sku string, price float64) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	item, ok := w.items[sku]
	if !ok {
		return errors.New("item not found")
	}
	if price < 0 {
		return errors.New("price cannot be negative")
	}
	item.Price = price
	return nil
}

// Rename updates an item's display name.
func (w *Warehouse) Rename(sku string, name string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	item, ok := w.items[sku]
	if !ok {
		return errors.New("item not found")
	}
	item.Name = name
	return nil
}

// Snapshot returns a shallow copy of all items, keyed by SKU.
func (w *Warehouse) Snapshot() map[string]Item {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := make(map[string]Item, len(w.items))
	for sku, item := range w.items {
		out[sku] = *item
	}
	return out
}

// ClearAll removes every tracked item.
func (w *Warehouse) ClearAll() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.items = make(map[string]*Item)
}

// FormatReceipt renders a simple human-readable receipt line for an item.
func FormatReceipt(item *Item) string {
	return fmt.Sprintf("%-10s %-20s qty=%-4d price=$%.2f", item.SKU, item.Name, item.Quantity, item.Price)
}

// ValidateSKU checks that a SKU is non-empty and reasonably short.
func ValidateSKU(sku string) error {
	if sku == "" {
		return errors.New("sku cannot be empty")
	}
	if len(sku) > 32 {
		return errors.New("sku too long")
	}
	return nil
}

// MergeWarehouses combines items from src into dst, summing quantities on collision.
func MergeWarehouses(dst *Warehouse, src *Warehouse) {
	src.mu.Lock()
	items := make([]*Item, 0, len(src.items))
	for _, item := range src.items {
		items = append(items, item)
	}
	src.mu.Unlock()

	for _, item := range items {
		dst.mu.Lock()
		existing, ok := dst.items[item.SKU]
		if ok {
			existing.Quantity += item.Quantity
		} else {
			copyItem := *item
			dst.items[item.SKU] = &copyItem
		}
		dst.mu.Unlock()
	}
}
