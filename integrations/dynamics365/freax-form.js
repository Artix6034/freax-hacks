/* Register FreaxCqa.onLoad on the form OnLoad event; pass execution context. */
var FreaxCqa = (()=>{
  'use strict';
  const settings={control:'WebResource_freax_cqa',transcriptField:'new_cqa_transcript',appUrl:'https://YOUR-FREAX-HOST',resultField:null};
  async function onLoad(executionContext){
    const form=executionContext.getFormContext();
    const control=form.getControl(settings.control);
    if(!control)throw new Error('Freax web resource control not found.');
    const content=await control.getContentWindow();
    const raw=form.getAttribute(settings.transcriptField)?.getValue();
    const conversation=typeof raw==='string'?JSON.parse(raw):raw;
    if(!conversation)throw new Error('CRM transcript field is empty.');
    content.FreaxHost.init({appUrl:settings.appUrl,conversation,onResult:result=>{
      // Optional result field only receives a summary. Saving the form stays with the operator.
      if(settings.resultField){const field=form.getAttribute(settings.resultField);if(field)field.setValue(JSON.stringify(result));}
    }});
  }
  return {settings,onLoad};
})();
