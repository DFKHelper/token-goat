#include <stdio.h>
#include <string.h>
#include <vector>

#define MAX_SIZE 1024
#define MIN_VAL 0
#define debug_log 1

typedef struct {
    int x;
    int y;
} Point;

struct Node {
    int val;
    struct Node* next;
};

enum Color { RED, GREEN, BLUE };

typedef int (*Comparator)(const void* a, const void* b);

extern int external_api(int x, int y);

namespace MyNS {
    class Calculator {
    public:
        int add(int a, int b) { return a + b; }
        int subtract(int a, int b) { return a - b; }
    };
}

int add(int a, int b) {
    return a + b;
}

static void helper(void) {
    printf("hello\n");
}

int MyNS::Calculator::multiply(int a, int b) {
    return a * b;
}
