#!/usr/bin/env bash
# canger: сборка и проверка на Linux (Arch)
# Запуск: bash canger-linux-setup.sh

set -euo pipefail

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m!!! %s\033[0m\n' "$1" >&2; exit 1; }

say "Проверка системы"
uname -a
cat /etc/os-release 2>/dev/null | head -n 3 || true
echo "--- архитектура: $(uname -m) ---"

say "Инструменты"
command -v cargo >/dev/null 2>&1 || die "Нет cargo. Установите Rust: https://rustup.rs (затем перезайдите в терминал)"
command -v node >/dev/null 2>&1 || die "Нет node. Установите Node.js 22 LTS"
cargo --version || true
node --version || true
npm --version || true

if ! cargo tauri --version >/dev/null 2>&1; then
  say "Ставлю tauri-cli (это долго, один раз)"
  cargo install tauri-cli --version "^2" --locked
fi
cargo tauri --version

say "Системные библиотеки для Tauri (Arch)"
sudo pacman -S --needed --noconfirm \
  webkit2gtk-4.1 \
  gtk3 \
  libappindicator-gtk3 \
  librsvg \
  patchelf \
  wget \
  file \
  openssl \
  curl || die "Не удалось поставить зависимости"

say "Проверяю, что библиотеки на месте"
pkg-config --modversion webkit2gtk-4.1 || die "webkit2gtk-4.1 не найден"
ldconfig -p | grep -E 'libwebkit2gtk-4.1' | head -n 3 || true

say "Готово. Теперь перейдите в каталог проекта и выполните:"
cat <<'EOF'

  git clone https://github.com/Huiotca22/Canger.git
  cd Canger
  npm install
  npm install --prefix frontend
  ./run-tauri.sh

EOF

say "Если что-то не собралось — пришлите вывод целиком"
