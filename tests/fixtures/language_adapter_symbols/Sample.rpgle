**FREE
// FORMAT-DERIVED: ILE RPG reference: **FREE https://www.ibm.com/support/knowledgecenter/ssw_ibm_i_74/rzasd/ssfree.htm , DCL-PROC https://ibm.com/support/knowledgecenter/ssw_ibm_i_73/rzasd/freeprocdef.htm , DCL-PR DCL-PI DCL-DS https://www.ibm.com/docs/en/i/7.3.0?topic=specifications-free-form-definition-statement , DCL-S DCL-C https://www.ibm.com/docs/ssw_ibm_i_74/rzasd/freeconstant.htm , ENDSR https://www.ibm.com/docs/en/i/7.4.0?topic=codes-endsr-end-subroutine , /COPY https://www.ibm.com/support/knowledgecenter/en/ssw_ibm_i_74/rzasd/cdcopy.htm
/COPY QRPGLESRC,CUSTPR
dcl-c MAX_ROWS 100;
dcl-s counter int(10);
dcl-ds custRec qualified;
  id int(10);
  name char(30);
end-ds;
dcl-pr getName char(30);
  custId int(10) const;
end-pr;
dcl-proc getName export;
  dcl-pi *n char(30);
    custId int(10) const;
  end-pi;
  dcl-s result char(30);
  exsr loadName;
  return result;
  begsr loadName;
    result = 'dcl-proc fake;'; // end-proc;
  endsr;
end-proc;
