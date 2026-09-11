* FORMAT-DERIVED: ABAP keyword documentation: REPORT https://help.sap.com/doc/abapdocu_751_index_htm/7.51/en-us/abapreport.htm , INCLUDE https://help.sap.com/doc/abapdocu_752_index_htm/7.52/en-US/abapinclude_prog.htm , CLASS DEFINITION https://help.sap.com/doc/abapdocu_751_index_htm/7.51/en-US/abapclass_definition.htm , DEFINITION DEFERRED https://help.sap.com/doc/abapdocu_750_index_htm/7.50/en-US/abapclass_deferred.htm , IMPLEMENTATION https://help.sap.com/doc/abapdocu_750_index_htm/7.50/en-US/abapclass_implementation.htm , METHOD https://help.sap.com/doc/abapdocu_750_index_htm/7.50/en-US/abapmethod.htm , FORM https://help.sap.com/doc/abapdocu_751_index_htm/7.51/en-US/abapform.htm , comments https://help.sap.com/doc/abapdocu_752_index_htm/7.52/en-us/abencomments_guidl.htm
REPORT zdemo_sales.
INCLUDE zdemo_top.
CLASS lcl_order DEFINITION DEFERRED.
CLASS lcl_order DEFINITION.
  PUBLIC SECTION.
    METHODS total RETURNING VALUE(rv_total) TYPE i.
ENDCLASS.
CLASS lcl_order IMPLEMENTATION.
  METHOD total.
    rv_total = 42. " ENDMETHOD. in a comment
  ENDMETHOD.
ENDCLASS.
FORM print_line USING iv_text TYPE string.
  WRITE: / 'FORM fake_form.'.
ENDFORM.
