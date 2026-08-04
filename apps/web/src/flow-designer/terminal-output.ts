const MONGODB_CREDENTIAL_PATTERN = new RegExp('(mongodb(?:\\\\+srv)?://[^:\\\\s/@]+:)[^@\\\\s]+(@)', 'gi');
const POSTGRES_CREDENTIAL_PATTERN = new RegExp('(postgres(?:ql)?://[^:\\\\s/@]+:)[^@\\\\s]+(@)', 'gi');

export function sanitizeTerminalText(value: string) {
  return maskTerminalSecrets(stripAnsiControlSequences(String(value || '')));
}

function stripAnsiControlSequences(value: string) {
  /* eslint-disable no-control-regex -- terminal output must remove ANSI and C0 control bytes */
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b[PX^_].*?\u001b\\/g, '')
    .replace(/\u001b[@-_]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  /* eslint-enable no-control-regex */
}

function maskTerminalSecrets(value: string) {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"'`]+/gi, '$1***')
    .replace(/(authorization\s*[:=]\s*basic\s+)[^\s"'`]+/gi, '$1***')
    .replace(/((?:password|passwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|connection[_-]?uri|credential|passphrase)\s*[=:]\s*)[^\s"'`]+/gi, '$1***')
    .replace(/([?&](?:token|secret|api[_-]?key|access[_-]?key|password|passphrase)=)[^&\s"'`]+/gi, '$1***')
    .replace(MONGODB_CREDENTIAL_PATTERN, '$1***$2')
    .replace(POSTGRES_CREDENTIAL_PATTERN, '$1***$2');
}
