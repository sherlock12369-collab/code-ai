// macOS: Apple 개발자 인증서가 없으므로 앱에 "ad-hoc" 서명을 한다.
// 서명이 아예 없으면 Apple Silicon(M1 이후) 맥은 앱을 "손상됨/열 수 없음"으로 실행하지 않는다.
// universal 빌드는 x64/arm64를 합친 마지막 결과물에만 서명한다.
const { execFileSync } = require('child_process');
const path = require('path');
const { Arch } = require('builder-util');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const targets = context.packager.platformSpecificBuildOptions.target || [];
  const buildingUniversal = JSON.stringify(targets).includes('universal');
  if (buildingUniversal && context.arch !== Arch.universal) return;

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`[adhoc-sign] ${app}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
};
