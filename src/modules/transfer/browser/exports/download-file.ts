export function downloadFile(parts: BlobPart[], name: string, type: string) {
  const url = URL.createObjectURL(new Blob(parts, { type })),
    anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
