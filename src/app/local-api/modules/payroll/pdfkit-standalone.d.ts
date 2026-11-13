// PDFKit's browser build bundles its own polyfills and fonts. It has the same API as the Node package.
declare module 'pdfkit/js/pdfkit.standalone' {
  import PDFDocument from 'pdfkit';
  export default PDFDocument;
}
