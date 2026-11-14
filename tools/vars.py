import struct
def read_vars(path):
    b=open(path,'rb').read()
    n=struct.unpack_from('<h',b,4)[0]; ns=struct.unpack_from('<h',b,6)[0]
    out={}; pos=0x5c; 
    for i in range(n):
        name=b[pos:pos+32].split(b'\0')[0].decode('latin1')
        v=struct.unpack_from('<d',b,pos+36)[0]
        out[name]=v; pos+=56
    return out,ns,len(b),pos
