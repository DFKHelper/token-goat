; FORMAT-DERIVED: NASM manual, multi-line macros and %include https://www.nasm.us/xdoc/2.16.03/html/nasmdoc4.html

section .text
global _start

%macro prologue 1
        push    ebp
        mov     ebp,esp
        sub     esp,%1
%endmacro

%imacro Foo 0
        mov %?,%??
%endmacro

struc mytype
  mt_long: resd 1
  mt_word: resw 1
endstruc

_start:
        prologue 12
        ; comment_label: sits in a line comment
        ret

%include "macros.mac"
