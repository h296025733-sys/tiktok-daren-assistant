$ErrorActionPreference = "Stop"

# Integration probe for the production route used by the visible side panel:
# side panel -> local batch API -> Google, with zh-CN local fallback.
# Fixed text only; no TikTok page content, cookies, URLs, or credentials.
$sourceText = "The smartest boy ever part 2"
$endpoint = "http://localhost:8765/api/v1/translations/batch"
$body = @{
    texts = @($sourceText)
    target_language = "zh-CN"
} | ConvertTo-Json -Depth 4

$response = Invoke-RestMethod `
    -Method Post `
    -Uri $endpoint `
    -ContentType "application/json; charset=utf-8" `
    -Headers @{ Origin = "chrome-extension://kpdocbejchofflefehdlphffcbdmphij" } `
    -Body $body `
    -TimeoutSec 30

if ($response.succeeded -ne 1 -or $response.failed -ne 0) {
    $errorCode = [string]$response.results[0].error_code
    throw "Foreground translation batch failed (diagnostic TDA-PROBE-RESULT, code=$errorCode)"
}

$item = $response.results[0]
$translatedText = [string]$item.translated_text
if ([string]::IsNullOrWhiteSpace($translatedText) -or $translatedText -eq $sourceText) {
    throw "Foreground translation batch returned no usable translation (diagnostic TDA-PROBE-TEXT)"
}

[PSCustomObject]@{
    route = "sidepanel -> localhost batch -> provider"
    endpoint = $endpoint
    target_language = [string]$response.target_language
    provider = [string]$item.provider
    detected_source_language = [string]$item.detected_source_language
    translated_text = $translatedText
    diagnostic = "TDA-PROBE-OK"
}
