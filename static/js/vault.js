// vault.js - 保险箱功能

const Vault = {
  // DOM refs
  $overlay: null,
  $panel: null,
  mode: 'deposit', // 'deposit' | 'pickup'
  
  init() {
    this.createOverlay();
    this.bindEvents();
  },
  
  createOverlay() {
    const html = `
      <div id="vaultOverlay" class="vault-overlay hidden">
        <div class="vault-panel">
          <div class="vault-header">
            <h3>🔒 保险箱</h3>
            <button class="vault-close" title="关闭">×</button>
          </div>
          
          <div class="vault-tabs">
            <button class="vault-tab active" data-tab="deposit">存入</button>
            <button class="vault-tab" data-tab="pickup">取件</button>
          </div>
          
          <!-- 存入界面 -->
          <div class="vault-content" id="vaultDeposit">
            <div class="vault-type-selector">
              <button class="vault-type-btn active" data-type="text">📝 文本</button>
              <button class="vault-type-btn" data-type="file">📎 文件</button>
            </div>
            
            <div class="vault-input-area" id="vaultTextArea">
              <textarea id="vaultTextInput" placeholder="在此输入要传递的文本内容..." maxlength="50000"></textarea>
              <div class="vault-char-count">0 / 50000</div>
            </div>
            
            <div class="vault-input-area hidden" id="vaultFileArea">
              <div class="vault-dropzone" id="vaultDropzone">
                <div>📁 点击选择或拖拽文件到此处</div>
                <div class="vault-hint">最大 100 MB</div>
              </div>
              <input type="file" id="vaultFileInput" hidden>
              <div class="vault-file-info hidden" id="vaultFileInfo"></div>
            </div>
            
            <div class="vault-expiry">
              ⏱️ 有效期：30 分钟
            </div>
            
            <button class="vault-submit" id="vaultDepositBtn">
              <span class="vault-btn-text">存入保险箱</span>
              <span class="vault-btn-progress hidden"></span>
            </button>
          </div>
          
          <!-- 取件界面 -->
          <div class="vault-content hidden" id="vaultPickup">
            <div class="vault-code-input">
              <label>输入 6 位收件码</label>
              <input type="text" id="vaultCodeInput" maxlength="6" placeholder="000000" inputmode="numeric">
              <button class="vault-query-btn" id="vaultQueryBtn">查看内容</button>
            </div>
            
            <div class="vault-result hidden" id="vaultResult">
              <!-- 动态填充 -->
            </div>
          </div>
          
          <!-- 结果展示（存入成功） -->
          <div class="vault-content hidden" id="vaultSuccess">
            <div class="vault-success-icon">✅</div>
            <div class="vault-success-title">已存入保险箱</div>
            <div class="vault-code-display">
              <label>收件码</label>
              <div class="vault-code-box">
                <span id="vaultCodeDisplay">------</span>
                <button class="vault-copy-btn" id="vaultCopyBtn">复制</button>
              </div>
            </div>
            <div class="vault-expiry-display" id="vaultExpiryDisplay"></div>
            <div class="vault-hint">取件后内容自动销毁</div>
            <button class="vault-done-btn" id="vaultDoneBtn">完成</button>
          </div>
        </div>
      </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', html);
    this.$overlay = document.getElementById('vaultOverlay');
    this.$panel = this.$overlay.querySelector('.vault-panel');
  },
  
  bindEvents() {
    // 关闭按钮
    this.$overlay.querySelector('.vault-close').addEventListener('click', () => this.hide());
    this.$overlay.addEventListener('click', (e) => {
      if (e.target === this.$overlay) this.hide();
    });
    
    // Tab 切换
    this.$overlay.querySelectorAll('.vault-tab').forEach(tab => {
      tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
    });
    
    // 类型切换
    this.$overlay.querySelectorAll('.vault-type-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchType(btn.dataset.type));
    });
    
    // 文本输入
    const $textInput = document.getElementById('vaultTextInput');
    $textInput.addEventListener('input', () => {
      document.querySelector('.vault-char-count').textContent = `${$textInput.value.length} / 50000`;
    });
    
    // 文件上传
    const $dropzone = document.getElementById('vaultDropzone');
    const $fileInput = document.getElementById('vaultFileInput');
    
    $dropzone.addEventListener('click', () => $fileInput.click());
    $dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      $dropzone.classList.add('drag-over');
    });
    $dropzone.addEventListener('dragleave', () => $dropzone.classList.remove('drag-over'));
    $dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      $dropzone.classList.remove('drag-over');
      if (e.dataTransfer.files.length) {
        this.handleFile(e.dataTransfer.files[0]);
      }
    });
    $fileInput.addEventListener('change', () => {
      if ($fileInput.files.length) this.handleFile($fileInput.files[0]);
    });
    
    // 存入按钮
    document.getElementById('vaultDepositBtn').addEventListener('click', () => this.deposit());
    
    // 收件码输入（自动大写）
    const $codeInput = document.getElementById('vaultCodeInput');
    $codeInput.addEventListener('input', () => {
      $codeInput.value = $codeInput.value.replace(/[^0-9]/g, '').slice(0, 6);
    });
    $codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && $codeInput.value.length === 6) {
        this.queryContent();
      }
    });
    
    // 查询按钮
    document.getElementById('vaultQueryBtn').addEventListener('click', () => this.queryContent());
    
    // 复制按钮
    document.getElementById('vaultCopyBtn').addEventListener('click', () => {
      const code = document.getElementById('vaultCodeDisplay').textContent;
      copyToClipboard(code);
    });
    
    // 完成按钮
    document.getElementById('vaultDoneBtn').addEventListener('click', () => {
      this.showPanel('deposit');
      this.clearForm();
    });
  },
  
  show() {
    this.$overlay.classList.remove('hidden');
    document.getElementById('vaultTextInput').focus();
  },
  
  hide() {
    this.$overlay.classList.add('hidden');
  },
  
  switchTab(tab) {
    this.$overlay.querySelectorAll('.vault-tab').forEach(t => t.classList.remove('active'));
    this.$overlay.querySelector(`[data-tab="${tab}"]`).classList.add('active');
    
    document.getElementById('vaultDeposit').classList.toggle('hidden', tab !== 'deposit');
    document.getElementById('vaultPickup').classList.toggle('hidden', tab !== 'pickup');
    document.getElementById('vaultSuccess').classList.add('hidden');
    
    if (tab === 'pickup') {
      document.getElementById('vaultCodeInput').focus();
    }
  },
  
  showPanel(panel) {
    document.getElementById('vaultDeposit').classList.toggle('hidden', panel !== 'deposit');
    document.getElementById('vaultPickup').classList.toggle('hidden', panel !== 'pickup');
    document.getElementById('vaultSuccess').classList.toggle('hidden', panel !== 'success');
  },
  
  switchType(type) {
    this.$overlay.querySelectorAll('.vault-type-btn').forEach(b => b.classList.remove('active'));
    this.$overlay.querySelector(`[data-type="${type}"]`).classList.add('active');
    
    document.getElementById('vaultTextArea').classList.toggle('hidden', type !== 'text');
    document.getElementById('vaultFileArea').classList.toggle('hidden', type !== 'file');
  },
  
  handleFile(file) {
    if (file.size > 100 * 1024 * 1024) {
      showToast('文件超过 100 MB 限制', 'error');
      return;
    }
    
    this.selectedFile = file;
    const $info = document.getElementById('vaultFileInfo');
    $info.innerHTML = `
      <span>📎 ${file.name}</span>
      <span>${formatBytes(file.size)}</span>
      <button class="vault-remove-file" onclick="Vault.clearFile()">×</button>
    `;
    $info.classList.remove('hidden');
  },
  
  clearFile() {
    this.selectedFile = null;
    document.getElementById('vaultFileInput').value = '';
    document.getElementById('vaultFileInfo').classList.add('hidden');
  },
  
  clearForm() {
    document.getElementById('vaultTextInput').value = '';
    document.querySelector('.vault-char-count').textContent = '0 / 50000';
    this.clearFile();
    this.switchType('text');
    this.switchTab('deposit');
  },
  
  async deposit() {
    const type = document.querySelector('.vault-type-btn.active').dataset.type;
    const $btn = document.getElementById('vaultDepositBtn');
    const $btnText = $btn.querySelector('.vault-btn-text');
    
    $btn.disabled = true;
    $btnText.textContent = '上传中...';
    
    try {
      const formData = new FormData();
      formData.append('type', type);
      
      if (type === 'text') {
        const content = document.getElementById('vaultTextInput').value.trim();
        if (!content) {
          showToast('请输入文本内容', 'error');
          return;
        }
        formData.append('content', content);
      } else {
        if (!this.selectedFile) {
          showToast('请选择文件', 'error');
          return;
        }
        formData.append('file', this.selectedFile);
      }
      
      const res = await fetch('/api/vault', {
        method: 'POST',
        body: formData
      });
      
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      
      // 显示成功界面
      document.getElementById('vaultCodeDisplay').textContent = data.data.code;
      const expiry = new Date(data.data.expires_at * 1000);
      document.getElementById('vaultExpiryDisplay').textContent = 
        `有效期至：${expiry.toLocaleString()}`;
      
      this.showPanel('success');
      
    } catch (e) {
      showToast('存入失败：' + e.message, 'error');
    } finally {
      $btn.disabled = false;
      $btnText.textContent = '存入保险箱';
    }
  },
  
  async queryContent() {
    const code = document.getElementById('vaultCodeInput').value.trim();
    if (code.length !== 6) {
      showToast('请输入 6 位收件码', 'error');
      return;
    }
    
    const $result = document.getElementById('vaultResult');
    $result.innerHTML = '<div class="vault-loading">查询中...</div>';
    $result.classList.remove('hidden');
    
    try {
      // 先查元数据
      const metaRes = await fetch(`/api/vault/${code}`);
      const meta = await metaRes.json();
      
      if (!meta.ok) {
        $result.innerHTML = '<div class="vault-error">收件码不存在或已过期</div>';
        return;
      }
      
      // 获取内容
      let contentHtml = '';
      if (meta.data.type === 'text') {
        const textRes = await fetch(`/api/vault/${code}/content`);
        const textData = await textRes.json();
        if (!textData.ok) throw new Error(textData.error);
        
        contentHtml = `
          <div class="vault-text-content">
            <pre>${escHtml(textData.data.content)}</pre>
            <button class="vault-copy-content" onclick="copyToClipboard(this.previousElementSibling.innerText)">复制文本</button>
          </div>
        `;
      } else {
        contentHtml = `
          <div class="vault-file-content">
            <div class="vault-file-icon">📎</div>
            <div class="vault-file-name">${escHtml(meta.data.file_name)}</div>
            <div class="vault-file-size">${formatBytes(meta.data.file_size)}</div>
            <a href="/api/vault/${code}/download" class="vault-download-btn" download>⬇ 下载文件</a>
          </div>
        `;
      }
      
      const expiry = new Date(meta.data.expires_at * 1000);
      $result.innerHTML = `
        <div class="vault-item-meta">
          <span>存入时间：${new Date(meta.data.created_at * 1000).toLocaleString()}</span>
          <span>有效期至：${expiry.toLocaleString()}</span>
        </div>
        ${contentHtml}
        <button class="vault-claim-btn" onclick="Vault.claimItem('${code}')">
          ✅ 确认收取，销毁内容
        </button>
      `;
      
    } catch (e) {
      $result.innerHTML = `<div class="vault-error">查询失败：${e.message}</div>`;
    }
  },
  
  async claimItem(code) {
    if (!confirm('内容将立即销毁，无法恢复。确认收取？')) return;
    
    try {
      const res = await fetch(`/api/vault/${code}`, { method: 'DELETE' });
      const data = await res.json();
      
      if (!data.ok) throw new Error(data.error);
      
      document.getElementById('vaultResult').innerHTML = `
        <div class="vault-claimed">
          <div class="vault-claimed-icon">🔒</div>
          <div>已收取并销毁</div>
        </div>
      `;
      
      setTimeout(() => {
        document.getElementById('vaultCodeInput').value = '';
        document.getElementById('vaultResult').classList.add('hidden');
      }, 2000);
      
    } catch (e) {
      showToast('收取失败：' + e.message, 'error');
    }
  }
};

// 初始化
Vault.init();
