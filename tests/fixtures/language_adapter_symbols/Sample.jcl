//* FORMAT-DERIVED: z/OS MVS JCL reference: fields and comments https://www.ibm.com/docs/SSLTBW_2.2.0/com.ibm.zos.v2r2.ieab600/iea3b6_JCL_statement_fields.htm , JOB https://www.ibm.com/docs/en/zos/2.2.0?topic=reference-job-statement , EXEC https://www.ibm.com/docs/en/zos-basic-skills?topic=concepts-jcl-statements-what-does-exec-statement-do , in-stream data https://www.ibm.com/docs/en/zos/2.1.0?topic=files-in-stream-data-sets , PROC https://www.ibm.com/docs/SSLTBW_2.2.0/com.ibm.zos.v2r2.ieab600/iea3b6_Examples_of_the_PROC_statement.htm , PEND https://www.ibm.com/docs/SSLTBW_2.2.0/com.ibm.zos.v2r2.ieab600/pendst.htm , INCLUDE https://www.ibm.com/docs/SSLTBW_2.2.0/com.ibm.zos.v2r2.ieab600/iea3b6_Examples_of_the_INCLUDE_statement_.htm
//PAYJOB   JOB (ACCT),'PAYROLL',CLASS=A
//CARDS    PROC
//PSTEP    EXEC PGM=IEBGENER
//SYSUT1   DD DSN=PAY.INPUT,DISP=SHR
//         PEND
//OUTPUT1  INCLUDE MEMBER=SYSOUT2
//STEP1    EXEC PGM=PAYCALC
//SYSIN    DD DATA
//FAKE     EXEC PGM=NOTREAL
/*
//STEP2    EXEC CARDS
//SYSPRINT DD SYSOUT=A
