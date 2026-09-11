* FORMAT-DERIVED: IBM High Level Assembler Language Reference. CSECT
* https://www.ibm.com/docs/en/SSENW6_1.6.0/asma400/csect.html, DSECT
* https://www.ibm.com/docs/en/SSENW6_1.6.0/asma400/dsect.html, START
* https://www.ibm.com/docs/en/SSENW6_1.6.0/asma400/start.html, MEND
* https://www.ibm.com/docs/en/SSENW6_1.6.0/asma400/mend.html, END
* https://www.ibm.com/docs/en/SSENW6_1.6.0/asma400/end.html, and ICTL,
* whose defaults 1,71,16 make 71 the end column
* https://www.ibm.com/docs/en/SSENW6_1.6.0/asma400/ictl.html
         MACRO
&LABEL   SAVEREGS &BASE
&LABEL   STM   14,12,12(13)
         MEND
MAIN     CSECT
         STM   14,12,12(13)
         SAVEREGS
SUBRTN   CSECT
         BR    14
MYDATA   DSECT
FIELDA   DS    CL8
         END
