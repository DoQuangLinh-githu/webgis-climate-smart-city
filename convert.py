from pdf2docx import Converter
import sys

def pdf_to_docx(input_pdf, output_docx):
    try:
        cv = Converter(input_pdf)
        cv.convert(output_docx, start=0, end=None)
        cv.close()
        print(f"[OK] Converted {input_pdf} to {output_docx}")
    except Exception as e:
        print(f"[ERROR] Conversion failed: {e}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python convert.py input.pdf output.docx")
    else:
        input_pdf = sys.argv[1]
        output_docx = sys.argv[2]
        pdf_to_docx(input_pdf, output_docx)
