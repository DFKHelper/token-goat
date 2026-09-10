-- HAND-DERIVED: standard Lua syntax written from language knowledge, not from any adapter regex.
local Warehouse = {}
Warehouse.__index = Warehouse

function Warehouse.new()
    local self = setmetatable({}, Warehouse)
    self.items = {}
    return self
end

function Warehouse:addItem(name, quantity)
    table.insert(self.items, { name = name, quantity = quantity })
end

return Warehouse
