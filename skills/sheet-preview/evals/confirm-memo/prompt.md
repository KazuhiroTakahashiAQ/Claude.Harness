見積書の「単価」列（C 列）が税抜か税込か依頼文からは分からない。sheet.json は confirm.sheet.json を使う。この点を人に確認するメモを付けて。付けたら、人が確認に「税込」と返信した想定で（confirm.review.json の t1 に human の返信「税込」を足した状態）、その返事を読んで反映するところまでやって。サーバは起動しなくてよい（API なら送る JSON を示す）。
Input files: confirm.sheet.json, confirm.review.json
