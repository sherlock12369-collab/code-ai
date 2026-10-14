// macOS: Apple 개발자 인증서가 없으므로 앱에 "ad-hoc" 서명을 한다.
// 서명이 아예 없으면 Apple Silicon(M1 이후) 맥은 앱을 "손상됨/열 수 없음"으로 실행하지 않는다.
// universal 빌드는 x64/arm64를 합친 마지막 결과물에만 서명한다.
const { execFileSync } = require('child_process');
const path = require('path');
const { Arch } = require('builder-util');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // universal 빌드 중간 결과물(x64/arm64 임시 폴더)은 건너뛰고, 합쳐진 결과물에만 서명한다.
  if (context.arch !== Arch.universal && /universal/i.test(context.appOutDir)) return;

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`[adhoc-sign] ${app}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
  // Intel/Apple Silicon 둘 다 들어 있는지 기록 (universal이면 "x86_64 arm64")
  const exe = path.join(app, 'Contents', 'MacOS', context.packager.appInfo.productFilename);
  console.log(`[adhoc-sign] archs: ${execFileSync('lipo', ['-archs', exe]).toString().trim()}`);
};
