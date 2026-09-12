#lang racket/base
;; FORMAT-DERIVED: Racket Reference, "Reading Text" (nested #| |# block comments, #; datum
;; comments, #<<id here-strings, #\ character literals) and "Definitions" (define, struct,
;; define-syntax-rule) -- this fixture follows those grammar productions, not this repo's
;; extractor.

#| An outer comment
   #| a nested comment -- the Racket Reference says #|...|# comments nest |#
   still inside the outer comment |#

(define (greet name)
  (string-append "hello " name))

;; #; elides the entire next datum -- this define must never become a symbol.
#;(define unused-thing 42)

(struct point (x y) #:transparent)

(define-syntax-rule (my-unless test body)
  (if test (void) body))

(define banner
  #<<EOS
This is a Racket here-string.
It can span "several" lines and contain #| not-a-comment |# literally.
EOS
  )

(define space-char #\space)
