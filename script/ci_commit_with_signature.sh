#!/bin/bash

set -eo pipefail
changed_files=()
deleted_files=()

while getopts ":T:R:B:P:F:D:h:b:" opt; do
    case $opt in
        T)
            # 通过 GitHub GraphQL API 进行身份验证的 TOKEN
            # TOKEN for authentication via the GitHub GraphQL API
            TOKEN=$OPTARG
            ;;
        R)
            # GitHub GraphQL API 请求带有所有者的远程仓库名称
            # Remote repository name with owner requested by the GitHub GraphQL API
            repoNwo=$OPTARG
            ;;
        B)
            # GitHub GraphQL API 请求的远程仓库目标分支名称
            # The name of the target branch of the remote repository requested by the GitHub GraphQL API
            branch=$OPTARG
            ;;
        P)
            # 远程仓库目标分支上最后一次提交的 SHA。
            # 它也是即将创建的提交的父提交的 SHA。
            # The SHA of the last commit on the target branch of the remote repository.
            # It is also the SHA of the parent commit of the commit about to be created.
            parentSHA=$OPTARG
            ;;
        F)
            # 通过 GitHub GraphQL API 提交, 新增或修改的文件的路径（相对于存储库根）的数组
            # Array of paths (relative to the repository root) to new or modified files for commits via the GitHub GraphQL API
            IFS=', ' read -ra changed_files <<< "${OPTARG:-}"
            # 使用逗号和或空格作为分隔符，将参数分割为数组，默认值为空字符串
            # Split parameters into arrays using commas and or spaces as separators, defaults to empty string
            ;;
        D)
            # 通过 GitHub GraphQL API 提交, 删除的文件的路径（相对于存储库根）的数组
            # Array of paths (relative to the repository root) to deleted files for commits via the GitHub GraphQL API
            IFS=', ' read -ra deleted_files <<< "${OPTARG:-}"
            ;;
        h)
            # 通过 GitHub GraphQL API 提交的提交消息标题行
            # Commit message head line committed via GitHub GraphQL API
            message_headline=$OPTARG
            ;;
        b)
            # 通过 GitHub GraphQL API 提交的提交消息正文
            # Commit message body committed via GitHub GraphQL API
            message_body=$OPTARG
            ;;
        \?)
           echo "无效的选项: -$OPTARG" >&2
           exit 1
           ;;
    esac
done

if [[ -z $TOKEN ]]; then
  TOKEN=$GITHUB_TOKEN
fi

if [[ -z $GITHUB_API_URL ]]; then
  GITHUB_API_URL="https://api.github.com"
fi

function set_dco_signature {
    if [[ $TOKEN == ghp_* ]]; then
        # https://github.blog/2021-04-05-behind-githubs-new-authentication-token-formats/
        # 'ghp_'开头的是 GitHub 个人访问令牌
        # What starts with 'ghp_' is the GitHub personal access token

        res=$(curl -s -H "Authorization: token $TOKEN" "$GITHUB_API_URL/user" 2>/dev/null || echo '{"login":"gh-actions","id":0}')
    else
        bot="${APP_SLUG:-github-actions}[bot]"
        res=$(curl -sg -H "Authorization: token $TOKEN" "$GITHUB_API_URL/users/${bot}" 2>/dev/null || echo '{"login":"gh-actions","id":0}')
    fi

    login=$(jq -r .login <<< "$res")
    name=$(jq -r '.name // empty' <<< "$res")
    id=$(jq -r .id <<< "$res")
    echo "Signed-off-by: ${name:-$login} <$id+$login@users.noreply.github.com>"
}

signature=$(set_dco_signature)
message_body="${message_body:-}"
if [[ -n $message_body ]]; then message_body+=$'\n'; fi
message_body+="$signature"

# Serialize JSON and base64 without line wrapping. Preserve quotes, Unicode,
# optional deletions and DCO newlines instead of hand-assembling JSON strings.
python3 - "$repoNwo" "$branch" "$parentSHA" "$message_headline" "$message_body" \
  "${#changed_files[@]}" "${changed_files[@]}" "${deleted_files[@]}" > request.json <<'REQUEST_PY'
import base64
import json
from pathlib import Path
import sys

repo, branch, parent, headline, body, count, *paths = sys.argv[1:]
count = int(count)
payload = {
    "query": "mutation ($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid url } } }",
    "variables": {"input": {
        "branch": {"repositoryNameWithOwner": repo, "branchName": branch},
        "message": {"headline": headline, "body": body},
        "fileChanges": {
            "additions": [{"path": path, "contents": base64.b64encode(Path(path).read_bytes()).decode("ascii")} for path in paths[:count]],
            "deletions": [{"path": path} for path in paths[count:]],
        },
        "expectedHeadOid": parent,
    }},
}
json.dump(payload, sys.stdout, ensure_ascii=False)
REQUEST_PY

# 发送 GraphQL 请求并解析结果
# Send GraphQL requests and parse the results
if [[ -z $GITHUB_GRAPHQL_URL ]]; then
  GITHUB_GRAPHQL_URL="https://api.github.com/graphql"
fi

response=$(curl "$GITHUB_GRAPHQL_URL" --silent \
  --write-out '%{stderr}HTTP status: %{response_code}\n\n' \
  -H "Authorization: bearer $TOKEN" \
  --data @request.json)

# Print the results
jq -r '
    if .data?.createCommitOnBranch?.commit?.url then
        "✅ 请求成功，SHA: \(.data.createCommitOnBranch.commit.oid)\nURL: \(.data.createCommitOnBranch.commit.url)"
    else
        if .errors then
            "❌ 错误列表:\n" + ([.errors[].message] | join("\n- "))
        else
            "⚠️ 未知响应格式: \(.)"
        end
    end' <<< "$response"

# HTTP 200 does not imply GraphQL success. Fail the workflow on API errors.
jq -e '.data.createCommitOnBranch.commit.oid | strings | select(length == 40)' <<< "$response" > /dev/null
