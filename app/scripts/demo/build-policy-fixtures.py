"""Regenerate fictional policy PDFs. Optional developer tool: requires reportlab."""
import json
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter

ROOT = Path(__file__).resolve().parents[2] / 'tests/fixtures/import-receiving/policy'
CASES = [
    ('supported', 'Supported packaging relationship', 'Alphacin Tablets', '10 mg', 'Example Labs Ltd', True),
    ('different-product', 'Reject different product with shared batch prefix', 'Betacin Tablets', '10 mg', 'Example Labs Ltd', False),
    ('different-strength', 'Reject different strength with shared batch prefix', 'Alphacin Tablets', '20 mg', 'Example Labs Ltd', False),
    ('different-manufacturer', 'Reject different manufacturer with shared batch prefix', 'Alphacin Tablets', '10 mg', 'Other Works Ltd', False),
]

def pdf(path, title, lines):
    doc = canvas.Canvas(str(path), pagesize=letter, invariant=1)
    doc.setTitle(title + ' - Fictional test data')
    doc.setFont('Helvetica-Bold', 10)
    doc.drawString(48, 750, 'FICTIONAL TEST DATA - all companies and identifiers are examples')
    doc.setFont('Helvetica-Bold', 20)
    doc.drawString(48, 706, title)
    doc.setFont('Helvetica', 11)
    y = 672
    for text in lines:
        doc.drawString(48, y, text)
        y -= 23
    doc.setFont('Helvetica', 9)
    doc.drawString(48, 42, 'Policy benchmark | page 1 of 1')
    doc.save()

manifest = []
for index, (key, name, product, strength, manufacturer, supported) in enumerate(CASES, 1):
    reference = f'SYN-POLICY-{index:02d}'
    invoice = f'{key}-invoice.pdf'
    coa = f'{key}-coa.pdf'
    pdf(ROOT / invoice, 'Commercial Invoice', [
        f'Shipment reference: {reference}', f'Invoice number: TEST-INV-{index:02d}',
        'Exporter and manufacturer: Example Labs Ltd',
        'Line 1 | Alphacin Tablets | Strength: 10 mg | Quantity: 100 packs',
        'HTS: TEST-HTS-01', 'ANDA: TEST-ANDA-01', 'FDA product code: TEST-FDA-01',
        'REG: TEST-REG-01', 'NDC: TEST-NDC-01', 'Packaging batch number: DEMO7701A',
    ])
    lines = [f'Manufacturer: {manufacturer}', f'Product: {product}',
             f'Strength: {strength}', 'Manufacturing batch number: DEMO7701',
             'Identity test: conforms', 'Assay test: conforms', 'Conclusion: batch meets specification']
    if supported:
        lines += ['', 'Batch relationship: packaging batch DEMO7701A was packaged',
                  'from manufacturing batch DEMO7701 for this same product and strength.',
                  'Both batches were manufactured by Example Labs Ltd.']
    pdf(ROOT / coa, 'Certificate of Analysis', lines)
    manifest.append({'key':key, 'name':name, 'shipment_reference':reference,
                     'documents':[invoice,coa], 'expected':{
                         'invoices_processed':1, 'invoices_succeeded':1, 'invoices_failed':0,
                         'goods_failed':0, 'batches_processed':1,
                         'batches_succeeded':1 if supported else 0,
                         'batches_failed':0 if supported else 1}})
(ROOT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Created {len(manifest)} cases and {len(manifest)*2} one-page PDFs in {ROOT}')
