/* FORMAT-DERIVED: OpenEdge ABL reference: PROCEDURE https://documentation.progress.com/output/ua/OpenEdge_latest/pdsoe/PLUGINS_ROOT/com.openedge.pdt.langref.help/rfi1424920170673.html , FUNCTION https://documentation.progress.com/output/ua/OpenEdge_latest/pdsoe/PLUGINS_ROOT/com.openedge.pdt.langref.help/rfi1424920293523.html , include reference https://documentation.progress.com/output/ua/OpenEdge_latest/dvref/%7B-%7D-include-file-reference.html , comments https://documentation.progress.com/output/ua/OpenEdge_latest/pdsoe/PLUGINS_ROOT/com.openedge.pdt.langref.help/rfi1424920649118.html and https://documentation.progress.com/output/ua/OpenEdge_latest/pdsoe/PLUGINS_ROOT/com.openedge.pdt.langref.help/juc1435064605435.html */
{ inc/common.i }
DEFINE VARIABLE iTotal AS INTEGER NO-UNDO.
DEFINE TEMP-TABLE ttOrder NO-UNDO
  FIELD OrderNum AS INTEGER.
FUNCTION addTax RETURNS DECIMAL (INPUT pAmount AS DECIMAL) FORWARD.
RUN calcTotal.
PROCEDURE calcTotal:
  FOR EACH ttOrder:
    iTotal = iTotal + 1.
  END.
  MESSAGE "PROCEDURE fake: END." VIEW-AS ALERT-BOX.
END PROCEDURE.
FUNCTION addTax RETURNS DECIMAL (INPUT pAmount AS DECIMAL):
  /* nested /* END. */ still a comment */
  RETURN pAmount * 1.1.
END FUNCTION.
