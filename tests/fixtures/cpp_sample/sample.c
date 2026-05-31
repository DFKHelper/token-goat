#include <stdio.h>
#include <stdlib.h>

#define BUFFER_SIZE 256
#define MAX_RETRIES 3

typedef struct {
    int x;
    int y;
} Vector2;

struct Queue {
    int* data;
    int head;
    int tail;
};

enum Direction { NORTH, SOUTH, EAST, WEST };

extern void platform_init(void);

int add(int a, int b) {
    return a + b;
}

static int compare(int a, int b) {
    return a - b;
}

void process(Vector2* v) {
    v->x = 0;
    v->y = 0;
}
