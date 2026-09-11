# FORMAT-DERIVED: GNU as manual, labels https://sourceware.org/binutils/docs/as/Statements.html and macros https://sourceware.org/binutils/docs/as/Macro.html
        .include "defs.inc"
        .text
        .globl main
main:
        call    helper
.Lloop:
        jmp     .Lloop
helper:
        # not_a_label: sits in a line comment
        movq    $msg, %rax
        ret
        .macro sum from=0, to=5
        .long   \from
inner_label:
        .endm
msg:
        .asciz  "string_label: sits in a string"
