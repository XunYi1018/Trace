const COFF_HEADER_SIZE = 20
const SECTION_HEADER_SIZE = 40
const RESOURCE_OFFSET = COFF_HEADER_SIZE + SECTION_HEADER_SIZE
const RESOURCE_TREE_SIZE = 0x58
const RELOCATION_SIZE = 10
const SYMBOL_SIZE = 18
const MAX_MANIFEST_BYTES = 64 * 1024 - 1
const IMAGE_REL_AMD64_ADDR32NB = 3
const SECTION_CHARACTERISTICS = 0xc0300040

// Keep this manifest deliberately small: the installer launches as the caller
// and only its fixed prerequisite-repair child asks ShellExecute for runas.
// Do not add compatibility or DPI declarations until the UI has been tested
// against those Windows behaviors.
export const installerManifest = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
</assembly>
`

function align4(value) {
  return (value + 3) & ~3
}

function writeResourceTree(resource, manifestBytes) {
  // Three IMAGE_RESOURCE_DIRECTORY levels: RT_MANIFEST (24), resource ID 1,
  // then language 0x409. Directory offsets are relative to this section.
  resource.writeUInt16LE(1, 0x0e)
  resource.writeUInt32LE(24, 0x10)
  resource.writeUInt32LE(0x80000018, 0x14)

  resource.writeUInt16LE(1, 0x26)
  resource.writeUInt32LE(1, 0x28)
  resource.writeUInt32LE(0x80000030, 0x2c)

  resource.writeUInt16LE(1, 0x3e)
  resource.writeUInt32LE(0x409, 0x40)
  resource.writeUInt32LE(0x48, 0x44)

  // IMAGE_RESOURCE_DATA_ENTRY. The first field is patched by Go's linker
  // through IMAGE_REL_AMD64_ADDR32NB when this .syso is linked into the PE.
  resource.writeUInt32LE(RESOURCE_TREE_SIZE, 0x48)
  resource.writeUInt32LE(manifestBytes.length, 0x4c)
  resource.writeUInt32LE(0, 0x50)
  resource.writeUInt32LE(0, 0x54)
  manifestBytes.copy(resource, RESOURCE_TREE_SIZE)
}

/**
 * Build an amd64 COFF object containing one RT_MANIFEST resource.
 *
 * The object uses the same single .rsrc / section-symbol shape emitted by
 * MinGW windres and consumed by Go's PE linker. Its resource data RVA is a
 * single IMAGE_REL_AMD64_ADDR32NB relocation, which the linker resolves when
 * it places the final .rsrc section in the executable.
 */
export function createWindowsManifestResource(manifestText) {
  if (typeof manifestText !== 'string') throw new TypeError('manifest text must be a string')
  if (manifestText.trim().length === 0) throw new Error('manifest text must be non-empty')
  const manifestBytes = Buffer.from(manifestText, 'utf8')
  if (manifestBytes.length === 0) throw new Error('manifest text must be non-empty')
  if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new RangeError('manifest text exceeds maximum 64 KiB')

  const resourceSize = align4(RESOURCE_TREE_SIZE + manifestBytes.length)
  const relocationOffset = RESOURCE_OFFSET + resourceSize
  const symbolOffset = relocationOffset + RELOCATION_SIZE
  const output = Buffer.alloc(symbolOffset + SYMBOL_SIZE + 4)

  output.writeUInt16LE(0x8664, 0)
  output.writeUInt16LE(1, 2)
  output.writeUInt32LE(0, 4)
  output.writeUInt32LE(symbolOffset, 8)
  output.writeUInt32LE(1, 12)
  output.writeUInt16LE(0, 16)
  output.writeUInt16LE(0x0004, 18)

  const section = COFF_HEADER_SIZE
  output.write('.rsrc', section, 8, 'ascii')
  output.writeUInt32LE(0, section + 8)
  output.writeUInt32LE(0, section + 12)
  output.writeUInt32LE(resourceSize, section + 16)
  output.writeUInt32LE(RESOURCE_OFFSET, section + 20)
  output.writeUInt32LE(relocationOffset, section + 24)
  output.writeUInt32LE(0, section + 28)
  output.writeUInt16LE(1, section + 32)
  output.writeUInt16LE(0, section + 34)
  output.writeUInt32LE(SECTION_CHARACTERISTICS, section + 36)

  const resource = output.subarray(RESOURCE_OFFSET, RESOURCE_OFFSET + resourceSize)
  writeResourceTree(resource, manifestBytes)

  output.writeUInt32LE(0x48, relocationOffset)
  output.writeUInt32LE(0, relocationOffset + 4)
  output.writeUInt16LE(IMAGE_REL_AMD64_ADDR32NB, relocationOffset + 8)

  output.write('.rsrc', symbolOffset, 8, 'ascii')
  output.writeUInt32LE(0, symbolOffset + 8)
  output.writeInt16LE(1, symbolOffset + 12)
  output.writeUInt16LE(0, symbolOffset + 14)
  output.writeUInt8(3, symbolOffset + 16)
  output.writeUInt8(0, symbolOffset + 17)
  output.writeUInt32LE(4, symbolOffset + SYMBOL_SIZE)
  return output
}
