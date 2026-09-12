;; FORMAT-DERIVED: R7RS-small (Revised^7 Report on Scheme) section 2.2 (whitespace and comments:
;; nested #| |# block comments, #; datum comments), section 5.3 (define, define-syntax,
;; define-record-type, define-values) and section 6.7 (characters) -- this fixture follows those
;; grammar productions, not this repo's extractor.

#| An outer comment
   #| a nested comment -- R7RS 2.2 says block comments can be nested |#
   still inside the outer comment |#

(define (make-greeter name)
  (lambda (visitor)
    (string-append "hello " name ", " visitor)))

;; #; elides the ENTIRE next datum -- this define-syntax must never become a symbol.
#;(define-syntax unused-macro
    (syntax-rules ()
      ((_ x) x)))

(define-record-type point
  (make-point x y)
  point?
  (x point-x)
  (y point-y))

(define-syntax my-when
  (syntax-rules ()
    ((_ test body ...) (if test (begin body ...) #f))))

(define-values (quotient-part remainder-part) (floor/ 7 2))

(define space-char #\space)
(define escaped-string "a \"quoted\" word")
