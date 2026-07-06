# typed: false
# frozen_string_literal: true

class Kitshn < Formula
  desc "Small VPS deployment system for GitHub repos"
  homepage "https://github.com/{{REPOSITORY}}"
  url "{{URL}}"
  sha256 "{{SHA256}}"
  license "MIT"
  head "https://github.com/{{REPOSITORY}}.git", branch: "main"

  depends_on "uv"

  def install
    libexec.install "pyproject.toml", "src"
    (bin/"kitshn").write <<~SH
      #!/bin/bash
      export KITSHN_SOURCE_REF="{{TAG}}"
      exec "#{formula_opt_bin("uv")}/uv" run --no-project --python 3.14 \
        --with 'kitshn @ file://#{libexec}' \
        kitshn "$@"
    SH
    chmod 0755, bin/"kitshn"
  end

  test do
    assert_match "Usage:", shell_output("#{bin}/kitshn --help")
  end
end
