param(
    [string]$Text = "",
    [string[]]$Keys = @(),
    [string]$KeysJson = "",
    [int]$Limit = 20,
    [switch]$Lite,
    [switch]$RequirePdf,
    [string]$ZoteroDir = "",
    [string]$DbPath = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not [string]::IsNullOrWhiteSpace($KeysJson)) {
    if ($KeysJson.Length -gt 20000) { throw "Слишком длинный список ключей Zotero" }
    $parsedKeys = ConvertFrom-Json -InputObject $KeysJson
    $Keys = @($parsedKeys | ForEach-Object { [string]$_ })
}

if ($Text.Length -gt 500) { throw "Слишком длинный поисковый запрос" }
if ($Keys.Count -gt 200) { throw "Слишком много ключей Zotero за один запрос" }
if ($Limit -lt 1) { $Limit = 1 }
if ($Limit -gt 50) { $Limit = 50 }

$cs = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class WinSqliteReader {
    [DllImport("winsqlite3.dll", EntryPoint="sqlite3_open16", CharSet=CharSet.Unicode, CallingConvention=CallingConvention.Cdecl)]
    private static extern int sqlite3_open16(string filename, out IntPtr db);

    [DllImport("winsqlite3.dll", CallingConvention=CallingConvention.Cdecl)]
    private static extern int sqlite3_close(IntPtr db);

    [DllImport("winsqlite3.dll", EntryPoint="sqlite3_prepare16_v2", CharSet=CharSet.Unicode, CallingConvention=CallingConvention.Cdecl)]
    private static extern int sqlite3_prepare16_v2(IntPtr db, string sql, int nByte, out IntPtr stmt, IntPtr tail);

    [DllImport("winsqlite3.dll", CallingConvention=CallingConvention.Cdecl)]
    private static extern int sqlite3_step(IntPtr stmt);

    [DllImport("winsqlite3.dll", CallingConvention=CallingConvention.Cdecl)]
    private static extern int sqlite3_finalize(IntPtr stmt);

    [DllImport("winsqlite3.dll", CallingConvention=CallingConvention.Cdecl)]
    private static extern int sqlite3_column_count(IntPtr stmt);

    [DllImport("winsqlite3.dll", EntryPoint="sqlite3_column_name16", CallingConvention=CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_column_name16(IntPtr stmt, int iCol);

    [DllImport("winsqlite3.dll", EntryPoint="sqlite3_column_text16", CallingConvention=CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_column_text16(IntPtr stmt, int iCol);

    [DllImport("winsqlite3.dll", CallingConvention=CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_errmsg16(IntPtr db);

    private const int SQLITE_ROW = 100;
    private const int SQLITE_DONE = 101;

    private static string PtrToString(IntPtr ptr) {
        return ptr == IntPtr.Zero ? "" : Marshal.PtrToStringUni(ptr);
    }

    public static List<Dictionary<string, string>> Query(string dbPath, string sql) {
        IntPtr db;
        int rc = sqlite3_open16(dbPath, out db);
        if (rc != 0) {
            throw new Exception("sqlite3_open16 failed: " + rc);
        }
        try {
            IntPtr stmt;
            rc = sqlite3_prepare16_v2(db, sql, -1, out stmt, IntPtr.Zero);
            if (rc != 0) {
                throw new Exception("sqlite3_prepare16_v2 failed: " + rc + " " + PtrToString(sqlite3_errmsg16(db)));
            }
            try {
                var rows = new List<Dictionary<string, string>>();
                int count = sqlite3_column_count(stmt);
                while (true) {
                    rc = sqlite3_step(stmt);
                    if (rc == SQLITE_DONE) break;
                    if (rc != SQLITE_ROW) {
                        throw new Exception("sqlite3_step failed: " + rc + " " + PtrToString(sqlite3_errmsg16(db)));
                    }
                    var row = new Dictionary<string, string>();
                    for (int i = 0; i < count; i++) {
                        row[PtrToString(sqlite3_column_name16(stmt, i))] = PtrToString(sqlite3_column_text16(stmt, i));
                    }
                    rows.Add(row);
                }
                return rows;
            } finally {
                sqlite3_finalize(stmt);
            }
        } finally {
            sqlite3_close(db);
        }
    }
}
"@

if (-not ("WinSqliteReader" -as [type])) {
    Add-Type -TypeDefinition $cs
}

function Find-VaultRoot {
    $scriptPath = if ($PSCommandPath) { $PSCommandPath } else { $MyInvocation.PSCommandPath }
    $here = Split-Path -Parent $scriptPath
    $current = Get-Item -LiteralPath $here
    while ($null -ne $current) {
        if (Test-Path -LiteralPath (Join-Path $current.FullName ".obsidian")) {
            return $current.FullName
        }
        $current = $current.Parent
    }
    return (Split-Path -Parent (Split-Path -Parent $here))
}

function Resolve-ConfiguredPath([string]$Raw, [string]$VaultRoot) {
    if ([string]::IsNullOrWhiteSpace($Raw)) { return $null }
    $candidate = $Raw.Trim()
    if ([System.IO.Path]::IsPathRooted($candidate)) { return $candidate }
    return (Join-Path $VaultRoot $candidate)
}

function Test-UncPath([string]$Path) {
    return -not [string]::IsNullOrWhiteSpace($Path) -and $Path.StartsWith("\\")
}

function Assert-SafeDbPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw "Путь к базе Zotero пуст" }
    if (Test-UncPath $Path) { throw "Сетевые UNC-пути к базе Zotero отключены в безопасном режиме" }
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    if ($item.PSIsContainer) { throw "Путь к базе Zotero указывает на папку" }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Символические ссылки на базу Zotero отключены в безопасном режиме" }
    if ($item.Name -ne "zotero.sqlite") { throw "Разрешено читать только файл zotero.sqlite" }
    if ($item.Length -gt 1024MB) { throw "База Zotero слишком большая для безопасного чтения" }
    return $item.FullName
}

function Get-DbCandidates([string]$VaultRoot) {
    $paths = New-Object System.Collections.Generic.List[string]
    $configuredDb = Resolve-ConfiguredPath $DbPath $VaultRoot
    if ($configuredDb) { $paths.Add($configuredDb) }

    $dirs = New-Object System.Collections.Generic.List[string]
    if ($configuredDb) { $dirs.Add((Split-Path -Parent $configuredDb)) }
    $configuredDir = Resolve-ConfiguredPath $ZoteroDir $VaultRoot
    if ($configuredDir) { $dirs.Add($configuredDir) }
    $dirs.Add((Join-Path $VaultRoot "Zotero"))
    $dirs.Add((Join-Path $env:USERPROFILE "Zotero"))

    foreach ($dir in $dirs) {
        if ([string]::IsNullOrWhiteSpace($dir)) { continue }
        $paths.Add((Join-Path $dir "zotero.sqlite"))
        $paths.Add((Join-Path $dir "zotero.sqlite.bak"))
        $paths.Add((Join-Path $dir "zotero.sqlite.1.bak"))
    }

    $seen = @{}
    foreach ($path in $paths) {
        if ([string]::IsNullOrWhiteSpace($path)) { continue }
        $key = $path.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        if (Test-Path -LiteralPath $path) {
            return Assert-SafeDbPath $path
        }
    }
    throw "Не найдена база Zotero"
}

function Copy-DbForRead([string]$SourcePath) {
    $SourcePath = Assert-SafeDbPath $SourcePath
    $target = Join-Path ([System.IO.Path]::GetTempPath()) ("zotero-read-" + [System.Guid]::NewGuid().ToString("N") + ".sqlite")
    Copy-Item -LiteralPath $SourcePath -Destination $target -Force
    return $target
}

function SqlEscape([string]$Value) {
    return ($Value -replace "'", "''")
}

function Assert-IntegerId([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch "^\d+$") {
        throw "Некорректный внутренний идентификатор Zotero"
    }
    return $Value
}

function Test-SafeRelativeStoragePath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    if (Test-UncPath $Path) { return $false }
    if ([System.IO.Path]::IsPathRooted($Path)) { return $false }
    $parts = @($Path -split "[\\/]+" | Where-Object { $_ })
    if ($parts.Count -eq 0) { return $false }
    foreach ($part in $parts) {
        if ($part -eq "." -or $part -eq "..") { return $false }
    }
    return $true
}

function Test-SafePdfFile([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    if (Test-UncPath $Path) { return $false }
    if ([System.IO.Path]::GetExtension($Path).ToLowerInvariant() -ne ".pdf") { return $false }
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    if ($item.PSIsContainer) { return $false }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
    return $true
}

function Resolve-StorageChildPath([string]$StorageRoot, [string]$RelativePath) {
    if (-not (Test-SafeRelativeStoragePath $RelativePath)) { return "" }
    if (-not (Test-Path -LiteralPath $StorageRoot)) { return "" }
    $rootItem = Get-Item -LiteralPath $StorageRoot -ErrorAction Stop
    if (-not $rootItem.PSIsContainer) { return "" }
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return "" }
    $rootFull = $rootItem.FullName.TrimEnd("\", "/")
    $candidateFull = [System.IO.Path]::GetFullPath((Join-Path $rootFull $RelativePath))
    $rootWithSeparator = $rootFull + [System.IO.Path]::DirectorySeparatorChar
    if (-not ($candidateFull.StartsWith($rootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase))) { return "" }
    if (Test-SafePdfFile $candidateFull) { return $candidateFull }
    return ""
}

function Invoke-Sql([string]$Sql) {
    $rows = [WinSqliteReader]::Query($script:TempDbPath, $Sql)
    return ,$rows
}

function Get-Fields([string]$ItemId) {
    $ItemId = Assert-IntegerId $ItemId
    $rows = Invoke-Sql @"
select f.fieldName as name, v.value as value
from itemData id
join itemDataValues v on v.valueID = id.valueID
join fieldsCombined f on f.fieldID = id.fieldID
where id.itemID = $ItemId
order by f.fieldName
"@
    $fields = @{}
    foreach ($row in $rows) { $fields[$row["name"]] = $row["value"] }
    return $fields
}

function Get-ItemType([string]$ItemId) {
    $ItemId = Assert-IntegerId $ItemId
    $rows = Invoke-Sql "select t.typeName as typeName from items i join itemTypes t on t.itemTypeID = i.itemTypeID where i.itemID = $ItemId"
    if ($rows.Count -gt 0) { return $rows[0]["typeName"] }
    return ""
}

function Get-ItemKey([string]$ItemId) {
    $ItemId = Assert-IntegerId $ItemId
    $rows = Invoke-Sql "select key as key from items where itemID = $ItemId"
    if ($rows.Count -gt 0) { return $rows[0]["key"] }
    return ""
}

function Get-Authors([string]$ItemId) {
    $ItemId = Assert-IntegerId $ItemId
    $rows = Invoke-Sql @"
select ic.orderIndex as orderIndex, c.firstName as firstName, c.lastName as lastName
from itemCreators ic
join creators c on c.creatorID = ic.creatorID
where ic.itemID = $ItemId
order by ic.orderIndex
"@
    $authors = @()
    foreach ($row in $rows) {
        $authors += [ordered]@{
            order = [int]($row["orderIndex"])
            first_name = if ($row["firstName"]) { $row["firstName"] } else { "" }
            last_name = if ($row["lastName"]) { $row["lastName"] } else { "" }
        }
    }
    return $authors
}

function Resolve-AttachmentPath([string]$AttachmentId, [string]$RawPath) {
    $AttachmentId = Assert-IntegerId $AttachmentId
    if ([string]::IsNullOrWhiteSpace($RawPath)) { return "" }
    if ($RawPath.StartsWith("storage:")) {
        $relativeName = $RawPath.Substring("storage:".Length)
        if (-not (Test-SafeRelativeStoragePath $relativeName)) { return "" }
        $attachmentKey = Get-ItemKey $AttachmentId
        if ($attachmentKey -and (Test-SafeRelativeStoragePath $attachmentKey)) {
            $storageRoot = Join-Path $script:ZoteroRoot "storage"
            $candidate = Resolve-StorageChildPath $storageRoot (Join-Path $attachmentKey $relativeName)
            if ($candidate) { return $candidate }
            $attachmentDir = Join-Path $storageRoot $attachmentKey
            if (Test-Path -LiteralPath $attachmentDir) {
                $pdfs = @(Get-ChildItem -LiteralPath $attachmentDir -File -Filter "*.pdf" -ErrorAction SilentlyContinue | Where-Object { Test-SafePdfFile $_.FullName })
                if ($pdfs.Count -eq 1) { return $pdfs[0].FullName }
                foreach ($pdf in $pdfs) {
                    if ($pdf.Name -eq $relativeName) { return $pdf.FullName }
                }
            }
        }
        return Resolve-StorageChildPath (Join-Path $script:ZoteroRoot "storage") $relativeName
    }
    return ""
}

function Get-Attachments([string]$ItemId) {
    $ItemId = Assert-IntegerId $ItemId
    $rows = Invoke-Sql "select itemID as itemID, parentItemID as parentItemID, contentType as contentType, path as path from itemAttachments where parentItemID = $ItemId order by itemID"
    $attachments = @()
    foreach ($row in $rows) {
        $attachments += [ordered]@{
            attachment_id = [int]$row["itemID"]
            parent_item_id = [int]$row["parentItemID"]
            content_type = if ($row["contentType"]) { $row["contentType"] } else { "" }
            path = Resolve-AttachmentPath $row["itemID"] $row["path"]
        }
    }
    return $attachments
}

function Get-PdfCount([string]$ItemId) {
    $ItemId = Assert-IntegerId $ItemId
    $rows = Invoke-Sql "select count(*) as count from itemAttachments where parentItemID = $ItemId and lower(contentType) = 'application/pdf'"
    if ($rows.Count -gt 0 -and $rows[0]["count"]) { return [int]$rows[0]["count"] }
    return 0
}

function Normalize-SearchText([string]$Value) {
    $text = ($Value + "").ToLowerInvariant().Replace("ё", "е")
    $text = $text.Replace("—", "-").Replace("–", "-")
    $text = [regex]::Replace($text, "[_:/\\]+", " ")
    $text = [regex]::Replace($text, "[-]+", " ")
    $text = [regex]::Replace($text, "\s+", " ")
    return $text.Trim()
}

function Get-CandidateItemIds([bool]$NeedPdf) {
    $pdfClause = ""
    if ($NeedPdf) {
        $pdfClause = "and exists (select 1 from itemAttachments a where a.parentItemID = i.itemID and lower(a.contentType) = 'application/pdf')"
    }
    $rows = Invoke-Sql @"
select i.itemID as itemID
from items i
where exists (
    select 1
    from itemData id
    join fieldsCombined f on f.fieldID = id.fieldID
    where id.itemID = i.itemID and f.fieldName = 'citationKey'
)
  and i.itemID not in (select itemID from deletedItems)
  $pdfClause
order by i.itemID desc
"@
    return @($rows | ForEach-Object { $_["itemID"] })
}

function Get-SearchableText([string]$ItemId) {
    $ItemId = Assert-IntegerId $ItemId
    $fields = Get-Fields $ItemId
    $authors = Get-Authors $ItemId
    $parts = @($fields.citationKey, $fields.title, $fields.shortTitle, $fields.publicationTitle, $fields.date, $fields.publisher, $fields.url, $fields.abstractNote)
    foreach ($author in $authors) {
        $parts += $author.first_name
        $parts += $author.last_name
    }
    return Normalize-SearchText (($parts | Where-Object { $_ }) -join " ")
}

function Get-SearchScore([string]$Query, [string]$Haystack) {
    if (-not $Query) { return 0 }
    $score = 0
    $index = $Haystack.IndexOf($Query)
    if ($index -ge 0) { $score = 1000 - $index }
    $tokens = @($Query.Split(" ") | Where-Object { $_ })
    foreach ($token in $tokens) {
        $tokenIndex = $Haystack.IndexOf($token)
        if ($tokenIndex -lt 0) { return $null }
        $score += 50
        $score += [Math]::Max(0, 20 - $tokenIndex)
    }
    return $score
}

function Get-ItemIdsByText([string]$Query, [int]$MaxCount, [bool]$NeedPdf) {
    $ids = Get-CandidateItemIds $NeedPdf
    if (-not $Query) { return @($ids | Select-Object -First $MaxCount) }
    $queryNorm = Normalize-SearchText $Query
    $scored = @()
    foreach ($id in $ids) {
        $score = Get-SearchScore $queryNorm (Get-SearchableText $id)
        if ($null -ne $score) {
            $scored += [pscustomobject]@{ score = $score; itemID = $id }
        }
    }
    return @($scored | Sort-Object @{Expression="score"; Descending=$true}, @{Expression="itemID"; Descending=$true} | Select-Object -First $MaxCount | ForEach-Object { $_.itemID })
}

function Get-ItemIdsByCitekey([string]$Citekey) {
    $safe = SqlEscape $Citekey
    $rows = Invoke-Sql @"
select distinct i.itemID as itemID
from itemDataValues v
join itemData id on id.valueID = v.valueID
join items i on i.itemID = id.itemID
join fieldsCombined f on f.fieldID = id.fieldID
where f.fieldName = 'citationKey' and v.value = '$safe'
order by i.itemID
"@
    return @($rows | ForEach-Object { $_["itemID"] })
}

function Clean-Text([string]$Value) {
    return [regex]::Replace(($Value + "").Trim(), "\s+", " ")
}

function Normalize-Initials([string]$Value) {
    $text = Clean-Text $Value
    if (-not $text) { return "" }
    if ($text.Contains(".")) {
        $letters = [regex]::Matches($text, "[A-Za-zА-Яа-яЁё]") | ForEach-Object { $_.Value.ToUpperInvariant() }
        if ($letters.Count -gt 0) { return (($letters -join ".") + ".") }
        return $text
    }
    $parts = @($text -split "[\s-]+" | Where-Object { $_ })
    if ($parts.Count -eq 0) { return $text }
    return ((@($parts | ForEach-Object { $_.Substring(0, 1).ToUpperInvariant() }) -join ".") + ".")
}

function Is-Patronymic([string]$Value) {
    return (Clean-Text $Value) -match "(вич|ич|вна|чна|инична|ична)$"
}

function Build-AuthorNames($RawAuthors) {
    $result = @()
    foreach ($author in $RawAuthors) {
        $firstName = Clean-Text $author.first_name
        $lastName = Clean-Text $author.last_name
        $firstParts = @($firstName -split "\s+" | Where-Object { $_ })
        if ($firstParts.Count -ge 2 -and (Is-Patronymic $lastName)) {
            $lastName = $firstParts[0]
            $firstName = (@($firstParts | Select-Object -Skip 1) + @($author.last_name)) -join " "
        }
        if ($firstName -and $lastName) { $result += "$lastName $(Normalize-Initials $firstName)" }
        elseif ($lastName) { $result += $lastName }
        elseif ($firstName) { $result += $firstName }
    }
    return $result
}

function Extract-Year([string]$Value) {
    $m = [regex]::Match($Value + "", "\b(19|20)\d{2}\b")
    if ($m.Success) { return $m.Value }
    return ""
}

function Normalize-Pages([string]$Value) {
    return (Clean-Text $Value).Replace("-", "–")
}

function With-Period([string]$Value) {
    $text = Clean-Text $Value
    if (-not $text) { return "" }
    if ($text -match "[.!?]$") { return $text }
    return "$text."
}

function Join-Parts($Parts) {
    return (($Parts | Where-Object { $_ }) -join " ").Trim()
}

function Format-Reference([string]$ItemType, $Authors, $Fields) {
    $authorText = ($Authors -join ", ")
    $title = Clean-Text $(if ($Fields.title) { $Fields.title } else { $Fields.shortTitle })
    $year = Extract-Year $Fields.date
    $journal = Clean-Text $Fields.publicationTitle
    $issue = Clean-Text $Fields.issue
    $volume = Clean-Text $Fields.volume
    $pages = Normalize-Pages $Fields.pages
    $url = Clean-Text $Fields.url

    $parts = @()
    if ($authorText) { $parts += With-Period $authorText }
    if ($title) {
        if ($journal -or $url) { $parts += "$title //" } else { $parts += With-Period $title }
    }
    if ($journal) { $parts += With-Period $journal }
    if ($year) { $parts += With-Period $year }
    if ($issue -and $volume) { $parts += With-Period "№ $issue ($volume)" }
    elseif ($issue) { $parts += With-Period "№ $issue" }
    elseif ($volume) { $parts += With-Period "Т. $volume" }
    if ($pages) { $parts += With-Period "С. $pages" }
    if (-not $journal -and $url) { $parts += "URL: $url" }
    return Join-Parts $parts
}

function Build-LiteItem([string]$ItemId) {
    $ItemId = Assert-IntegerId $ItemId
    $fields = Get-Fields $ItemId
    $pdfCount = Get-PdfCount $ItemId
    return [ordered]@{
        item_id = [int]$ItemId
        citekey = if ($fields.citationKey) { $fields.citationKey } else { "" }
        title = if ($fields.title) { $fields.title } else { "" }
        date = if ($fields.date) { $fields.date } else { "" }
        publication = if ($fields.publicationTitle) { $fields.publicationTitle } else { "" }
        authors = @(Get-Authors $ItemId)
        has_pdf = $pdfCount -gt 0
        pdf_count = $pdfCount
    }
}

function Build-FullItem([string]$ItemId, [string]$Citekey) {
    $ItemId = Assert-IntegerId $ItemId
    $fields = Get-Fields $ItemId
    $authorsRaw = @(Get-Authors $ItemId)
    $authors = @(Build-AuthorNames $authorsRaw)
    $attachments = @(Get-Attachments $ItemId)
    $pdfPaths = @($attachments | Where-Object { $_.content_type -eq "application/pdf" -and $_.path } | ForEach-Object { $_.path })
    $itemType = Get-ItemType $ItemId
    return [ordered]@{
        citekey = $Citekey
        item_ids = @([int]$ItemId)
        selected_item_id = [int]$ItemId
        item_type = $itemType
        title = if ($fields.title) { $fields.title } else { "" }
        publication = if ($fields.publicationTitle) { $fields.publicationTitle } else { "" }
        year = Extract-Year $fields.date
        url = if ($fields.url) { $fields.url } else { "" }
        authors = $authors
        pdf_paths = $pdfPaths
        formatted_reference = Format-Reference $itemType $authors $fields
    }
}

$vaultRoot = Find-VaultRoot
$sourceDbPath = Get-DbCandidates $vaultRoot
$script:ZoteroRoot = Split-Path -Parent $sourceDbPath
$script:TempDbPath = Copy-DbForRead $sourceDbPath

try {
    if ($Keys.Count -gt 0) {
        $items = [ordered]@{}
        $resolved = @()
        $unresolved = @()
        $references = @()
        $duplicates = [ordered]@{}
        $number = 1
        foreach ($key in $Keys) {
            $ids = @(Get-ItemIdsByCitekey $key)
            if ($ids.Count -eq 0) {
                $unresolved += $key
                continue
            }
            $item = Build-FullItem $ids[0] $key
            $item.item_ids = @($ids | ForEach-Object { [int]$_ })
            $items[$key] = $item
            $resolved += $key
            $references += [ordered]@{ citekey = $key; number = $number; text = $item.formatted_reference }
            if ($ids.Count -gt 1) { $duplicates[$key] = @($ids | ForEach-Object { [int]$_ }) }
            $number += 1
        }
        [ordered]@{
            zotero_dir = $script:ZoteroRoot
            db_path = $sourceDbPath
            resolved_keys = $resolved
            unresolved_keys = $unresolved
            duplicate_keys = $duplicates
            items = $items
            references = $references
        } | ConvertTo-Json -Depth 20
    } else {
        $ids = @(Get-ItemIdsByText $Text $Limit $RequirePdf.IsPresent)
        [ordered]@{
            zotero_dir = $script:ZoteroRoot
            db_path = $sourceDbPath
            count = $ids.Count
            items = @($ids | ForEach-Object { Build-LiteItem $_ })
        } | ConvertTo-Json -Depth 20
    }
} finally {
    if ($script:TempDbPath -and (Test-Path -LiteralPath $script:TempDbPath)) {
        Remove-Item -LiteralPath $script:TempDbPath -Force -ErrorAction SilentlyContinue
    }
}
