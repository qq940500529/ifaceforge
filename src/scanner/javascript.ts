import { parse } from '@babel/parser';

export function parseJavaScript(path: string, text: string) {
  return parse(text, {
    sourceType: 'unambiguous',
    plugins: [
      /\.(?:[cm]?ts|tsx)$/i.test(path) ? 'typescript' : 'jsx',
      ...(/\.tsx$/i.test(path) ? ['jsx' as const] : []),
    ],
  });
}
