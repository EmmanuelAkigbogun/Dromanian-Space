export function isPdfFile(fileType: string, fileName = ''): boolean {
  return fileType.toLowerCase() === 'application/pdf' || /\.pdf$/i.test(fileName.trim());
}
