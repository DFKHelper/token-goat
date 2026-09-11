/* FORMAT-DERIVED: SAS references: %MACRO https://support.sas.com/documentation/cdl/en/mcrolref/61885/HTML/default/macro-stmt.htm , DATA https://support.sas.com/documentation/cdl/en/lrdict/64316/HTML/default/a000188132.htm , %INCLUDE http://support.sas.com/documentation//cdl/en/lestmtsref/63323/HTML/default/p1s3uhhqtscz2sn1otiatbovfn1t.htm , comment statements https://support.sas.com/documentation/cdl/en/lestmtsref/63323/HTML/default/n1v51exifva71an1cvfn2z6j26lo.htm and https://support.sas.com/documentation/cdl/en/mcrolref/61885/HTML/default/a000543665.htm */
%include 'setup.sas';
* data fake_step;
%macro report(ds=);
  %* data also_fake;
  data work.summary;
    set &ds;
    total = price * qty;
  run;
  proc print data=work.summary;
  run;
%mend report;
data _null_;
  put 'data not_a_step;';
run;
data sales;
  input region $ amount;
  datalines;
east 100 data fake
o'neil 200
;
run;
