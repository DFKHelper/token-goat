/* HAND-DERIVED: standard C syntax written from language knowledge, not from any adapter regex. */
#include <stdio.h>

struct Item {
    char name[32];
    int quantity;
};

int add_quantity(int a, int b) {
    return a + b;
}

void print_item(struct Item *item) {
    printf("%s: %d\n", item->name, item->quantity);
}
