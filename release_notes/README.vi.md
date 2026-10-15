# Release notes và chuẩn bị phát hành

[English](README.md)

[Notes 2.1.0 đề xuất](v2.1.0.vi.md) theo bố cục
[release 2.0.0 mới nhất](https://github.com/ardennguyen/zalo-agent-cli/releases/tag/v2.0.0):
tên gói/version, kết quả chính, điểm nổi bật, tương thích/lỗi sửa, giới hạn và
cập nhật. Chỉ dùng lại cấu trúc, không kế thừa tuyên bố test tài khoản thật của
bản trước. CHANGELOG.md giữ lịch sử source.

2.1.0 là phiên bản đề xuất cho tính năng bổ sung, chưa ghi vào package.json
(upstream hiện ghi 2.0.1), chưa tag/publish. Merge PR #2/#3/#4 vào `v2.0-dev`,
kiểm tra bản tích hợp rồi chốt notes. Maintainer có thể chọn version khác;
nếu đổi phải cập nhật cả hai notes và các manifest.

## Chuẩn bị qua GitHub, không cần máy coding

[prepare-release.yml](prepare-release.yml) là template chưa kích hoạt, dùng
chung với đề xuất wrapper. Đưa một lần vào
`.github/workflows/prepare-release.yml` trên default branch upstream qua PR
đã review. Cho phép Actions tạo PR (`contents: write`, `pull-requests: write`).
Maintainer chọn **Actions → Prepare release PR → Run workflow**, nhập `2.1.0`,
rồi review PR `chore/release-2.1.0` → `v2.0-dev`.

Runner checkout nhánh upstream tin cậy, từ chối version đã phát hành, chạy
`npm version <version> --no-git-tag-version --ignore-scripts`, tạo lockfile thật:

```bash
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
npm ci
npm run format
npm run lint
npm run format:check
npm test
```

Chỉ commit package.json/package-lock.json rồi push ngay lên branch mới và mở PR;
hai manifest cũng có trong artifact workflow. Không push thẳng nhánh release,
tag, publish npm hay deploy. Không force-push branch chuẩn bị đã có. GitHub có
thể yêu cầu **Approve workflows to run** cho CI của PR bot.

Sau review/merge PR chuẩn bị, đưa nhánh phát triển đã review lên main theo
chính sách upstream. Tạo tag đúng version từ main bằng giao diện GitHub Release,
dán notes và chỉ bỏ dòng đề xuất khi đã đủ điều kiện. `publish.yml` hiện có
publish qua npm trusted publishing. Không cần npm publish thủ công hay PC maintainer.

Phát hành engine trước, rồi wrapper mới resolve được `^2.0.1` và chuẩn bị PR
lockfile 1.1.0. Mỗi repo có lockfile riêng; không chép lock engine sang wrapper.
`npm ci` kiểm tra nhất quán, không sửa lock cũ. Với PR wrapper hiện tại,
contributor có thể tạo lại và push lock lên chính PR sau publish; bot là lựa
chọn thêm, không phải điều kiện bắt buộc để merge.

Workflow phải có trên default branch để có nút Actions thủ công; `v2.0-dev`
phải tồn tại. Không checkout code fork với token quyền ghi. Hiện chỉ kiểm tra
tĩnh YAML/shell; chưa chạy upstream, tạo release hay test tài khoản thật.
Giữ nguyên workflow publish hiện có.

Nguồn: [npm install](https://docs.npmjs.com/cli/v11/commands/npm-install/),
[npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/),
[chạy Actions thủ công](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow),
[GITHUB_TOKEN và CI của PR](https://docs.github.com/en/actions/concepts/security/github_token).
