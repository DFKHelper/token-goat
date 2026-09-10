// HAND-DERIVED: standard C++ syntax written from language knowledge, not from any adapter regex.
#include <string>

namespace inventory {

class Item {
public:
    Item(const std::string &name, int quantity) : name_(name), quantity_(quantity) {}

    int quantity() const { return quantity_; }

private:
    std::string name_;
    int quantity_;
};

int add_quantity(int a, int b) {
    return a + b;
}

}  // namespace inventory
