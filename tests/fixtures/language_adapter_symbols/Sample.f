C FORMAT-DERIVED: https://www.ibm.com/docs/en/xl-fortran-aix/16.1.0?topic=formats-fixed-source-form (C and * comment lines in column 1, labels in columns 1-5, continuation in column 6, statement text in columns 7-72)
      PROGRAM MAIN
      REAL X(10)
      CALL FILL(X, 10)
      END
*     A subroutine header continued onto a second line in column 6
      SUBROUTINE FIL
     +L(A, N)
      INTEGER N
      REAL A(N)
      DO 10 I = 1, N
         A(I) = 0.0
   10 CONTINUE
      IF (N .GT. 0) THEN
         A(1) = 1.0
      END IF
      RETURN
      END
      REAL FUNCTION TWICE(Y)
      REAL Y
      TWICE = 2.0 * Y
      END FUNCTION TWICE
