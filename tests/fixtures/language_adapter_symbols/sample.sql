-- HAND-DERIVED: standard SQL syntax written from language knowledge, not from any adapter regex.
CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_items_name ON items (name);

CREATE VIEW low_stock AS
SELECT id, name, quantity FROM items WHERE quantity < 5;
